// Booking and listing events -> notifications (P11-T04).
//
//   plan(event, ctx)      -> [{ userId, type, ref, payload }]   pure: who is told what
//   notifier.dispatch(event, ctx)                               sends the plan, never throws
//
// The table below is the whole policy: for each event, who is told, the
// notification type, the text and the link. Texts are plain; they use only
// facts the recipient may know (the listing title, the dates, the reason an
// admin gave the host). Nobody is told about their own action: the guest who
// cancels is not notified that they cancelled.
//
//   event                  told            type                        link
//   reservation.requested  host            reservation.requested       /host/reservations
//   reservation.booked     host            reservation.booked          /host/reservations   (instant book)
//   reservation.accepted   guest           reservation.accepted        /trips/:id
//   reservation.declined   guest           reservation.declined        /trips/:id
//   reservation.expired    guest + host    reservation.expired         /trips/:id | /host/reservations
//   reservation.cancelled  the other side  reservation.cancelled       /trips/:id | /host/reservations
//   reservation.checkin_tomorrow  guest + host  reservation.checkin_tomorrow
//   review.available       guest           review.available            /trips/:id#review
//   listing.suspended      host            listing.suspended           /host/listings/:id/status
//   listing.restored       host            listing.restored            /host/listings/:id/status
//
// A failed notification never fails the booking or the admin action: dispatch
// logs and carries on. With no database connection there is nowhere to write,
// so it does nothing (this also keeps unit tests that stub the models quiet).
const { idOf } = require("../policies/shared");
const { LIMITS } = require("../config/notifications");

// Control characters would make `notify` refuse the whole message.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** One line of plain text no longer than `max` characters. */
function clip(value, max) {
  const text = String(value === undefined || value === null ? "" : value)
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

const dayFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC", // a stay's dates are date-only UTC midnights
});
const day = (date) => (date instanceof Date ? dayFormat.format(date) : "");

const titleOf = (r) =>
  clip((r.listingSnapshot && r.listingSnapshot.title) || "your stay", 70);
const range = (r) => `${day(r.checkIn)} to ${day(r.checkOut)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const guestUrl = (r) => `/trips/${idOf(r)}`;
const HOST_URL = "/host/reservations";

function reservationTargets(r) {
  return {
    ref: { kind: "reservation", id: idOf(r) },
    guest: idOf(r.guest),
    host: idOf(r.host),
  };
}

function toGuest(r, type, title, body, url = guestUrl(r)) {
  const t = reservationTargets(r);
  return { userId: t.guest, type, ref: t.ref, payload: { title, body, url } };
}
function toHost(r, type, title, body, url = HOST_URL) {
  const t = reservationTargets(r);
  return { userId: t.host, type, ref: t.ref, payload: { title, body, url } };
}

const EVENTS = {
  "reservation.requested": ({ reservation: r }) => [
    toHost(
      r,
      "reservation.requested",
      `New booking request: ${titleOf(r)}`,
      `A guest asked to stay ${range(r)} (${plural(r.nights, "night")}, ${plural(r.guests, "guest")}). Answer before the request runs out.`,
    ),
  ],
  "reservation.booked": ({ reservation: r }) => [
    toHost(
      r,
      "reservation.booked",
      `New booking: ${titleOf(r)}`,
      `${range(r)}, ${plural(r.nights, "night")}, ${plural(r.guests, "guest")}. It was confirmed instantly.`,
    ),
  ],
  "reservation.accepted": ({ reservation: r }) => [
    toGuest(
      r,
      "reservation.accepted",
      `Booking confirmed: ${titleOf(r)}`,
      `The host accepted your request for ${range(r)}.`,
    ),
  ],
  "reservation.declined": ({ reservation: r }) => [
    toGuest(
      r,
      "reservation.declined",
      `Request declined: ${titleOf(r)}`,
      `The host declined your request for ${range(r)}.`,
    ),
  ],
  "reservation.expired": ({ reservation: r }) => [
    toGuest(
      r,
      "reservation.expired",
      `Request expired: ${titleOf(r)}`,
      `The host did not answer in time, so your request for ${range(r)} ended.`,
    ),
    toHost(
      r,
      "reservation.expired",
      `A request expired: ${titleOf(r)}`,
      `You did not answer the request for ${range(r)} in time.`,
    ),
  ],
  // Told: the side that did NOT cancel. `r.cancelledBy` is "guest" or "host".
  "reservation.cancelled": ({ reservation: r }) => {
    if (r.cancelledBy === "guest") {
      return [
        toHost(
          r,
          "reservation.cancelled",
          `Booking cancelled: ${titleOf(r)}`,
          `The guest cancelled ${range(r)}. Those nights are open again.`,
        ),
      ];
    }
    if (r.cancelledBy === "host") {
      const why = r.cancelReason ? ` Reason: ${clip(r.cancelReason, 160)}` : "";
      return [
        toGuest(
          r,
          "reservation.cancelled",
          `Booking cancelled by the host: ${titleOf(r)}`,
          `The host cancelled your stay for ${range(r)}.${why}`,
        ),
      ];
    }
    return []; // cancelled by neither side: nobody to tell
  },
  "reservation.checkin_tomorrow": ({ reservation: r }) => [
    toGuest(
      r,
      "reservation.checkin_tomorrow",
      `Check-in tomorrow: ${titleOf(r)}`,
      `Your stay starts ${day(r.checkIn)}.`,
    ),
    toHost(
      r,
      "reservation.checkin_tomorrow",
      `Guest arriving tomorrow: ${titleOf(r)}`,
      `A guest checks in on ${day(r.checkIn)}.`,
    ),
  ],
  "review.available": ({ reservation: r }) => [
    toGuest(
      r,
      "review.available",
      `How was ${titleOf(r)}?`,
      "Your stay is over. You can leave a review.",
      `${guestUrl(r)}#review`,
    ),
  ],
  "listing.suspended": ({ listing, reason }) => [
    listingNotice(
      listing,
      "listing.suspended",
      `Your listing was suspended: ${clip(listing.title, 70)}`,
      `It is no longer visible to guests.${reason ? ` Reason: ${clip(reason, 200)}` : ""}`,
    ),
  ],
  "listing.restored": ({ listing }) => [
    listingNotice(
      listing,
      "listing.restored",
      `Your listing is visible again: ${clip(listing.title, 70)}`,
      "An admin restored it. Guests can find and book it.",
    ),
  ],
};

function listingNotice(listing, type, title, body) {
  const id = idOf(listing);
  return {
    userId: idOf(listing.owner),
    type,
    ref: { kind: "listing", id },
    payload: { title, body, url: `/host/listings/${id}/status` },
  };
}

/** The events this module knows. */
const EVENT_NAMES = Object.freeze(Object.keys(EVENTS));

/**
 * Who is told what for `event`. Pure. Texts are cut to the notification limits.
 * Entries without a recipient are left out.
 * @throws {Error} for an unknown event name (a programming mistake)
 */
function plan(event, ctx) {
  const build = Object.prototype.hasOwnProperty.call(EVENTS, event)
    ? EVENTS[event]
    : null;
  if (!build) throw new Error(`Unknown notification event: ${event}`);
  return build(ctx || {})
    .filter((p) => p && p.userId)
    .map((p) => ({
      ...p,
      payload: {
        title: clip(p.payload.title, LIMITS.title),
        body: clip(p.payload.body, LIMITS.body),
        url: p.payload.url,
      },
    }));
}

const dbConnected = () => require("mongoose").connection.readyState === 1;

/**
 * @param {object} [deps] `notify` (default: services/notifications), `connected`
 *   (default: the Mongoose connection is open), `logger`
 */
function createNotifier({ notify, connected = dbConnected, logger = console } = {}) {
  const send = notify || ((...args) => require("./notifications").notify(...args));
  /** Sends the plan for `event`. Never throws. @returns {Promise<number>} how many were stored */
  async function dispatch(event, ctx) {
    let sent = 0;
    try {
      if (!connected()) return 0;
      for (const p of plan(event, ctx)) {
        try {
          await send(p.userId, p.type, p.ref, p.payload);
          sent += 1;
        } catch (err) {
          logger.warn(`notification ${p.type} was not stored: ${err && err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`notification event ${event} failed: ${err && err.message}`);
    }
    return sent;
  }
  return { dispatch };
}

module.exports = { plan, createNotifier, notifier: createNotifier(), EVENT_NAMES, clip };
