// The host's reservations inbox (P09-T02): what is waiting for an answer, what
// is confirmed, and accepting or declining a request. Moving the booking is
// services/reservations.js `transition` (compare-and-set); this file adds who
// may do it, the listing check, the reason and the page's data.
//
//   listInbox({ ... }, hostId, { now })      -> { pending, confirmed, truncated }
//   respond({ ... }, { id, user, decision, reason, now })
//        decision "accept" | "decline"; returns the updated reservation
const { can } = require("../policies");
const { ConflictError, NotFoundError } = require("../utils/errors");
const { DEFAULT_TIMEZONE, todayIn } = require("../utils/dates");
const { formatMoney } = require("../utils/money");
const { formatStayDate, formatInstant, referenceOf } = require("./trips");
const { parseReason, REASON_MAX } = require("../utils/reason");

const LIMIT = 50; // per section; a bigger backlog is shown as "showing the first 50"
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "5 h 12 min", "42 min", "less than a minute", or "" once it has passed. */
function countdownText(expiresAt, now) {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${plural(days, "day", "days")} ${hours % 24} h`;
  }
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}

const idText = (v) => String(v && v._id ? v._id : v);

function guestSummary(guest, previousStays) {
  if (
    !guest ||
    typeof guest !== "object" ||
    typeof guest.toHexString === "function"
  ) {
    return {
      name: "A guest",
      profileUrl: null,
      memberSince: null,
      previousStays,
    };
  }
  return {
    name: guest.displayName || guest.username || "A guest",
    profileUrl: `/users/${idText(guest)}`,
    memberSince: guest.createdAt
      ? new Intl.DateTimeFormat("en-IN", {
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(guest.createdAt)
      : null,
    previousStays,
  };
}

function describeInboxRow(reservation, { previousStays, now }) {
  const snap = reservation.listingSnapshot || {};
  const price = reservation.pricingSnapshot || {};
  const expiresAt =
    reservation.holdExpiresAt instanceof Date
      ? reservation.holdExpiresAt
      : null;
  const waiting =
    reservation.status === "pending" && expiresAt && expiresAt > now;
  return {
    id: idText(reservation._id),
    reference: referenceOf(reservation),
    status: reservation.status,
    listingTitle: snap.title || "Your place",
    checkIn: formatStayDate(reservation.checkIn),
    checkOut: formatStayDate(reservation.checkOut),
    nights: reservation.nights,
    guests: reservation.guests,
    guestTotal: Number.isSafeInteger(price.totalMinor)
      ? formatMoney(price.totalMinor, price.currency || "INR")
      : null,
    guest: guestSummary(
      reservation.guest,
      previousStays.get(idText(reservation.guest)) || 0,
    ),
    // A request can be answered only while its hold is running.
    canAnswer: Boolean(waiting),
    expiresAtIso: waiting ? expiresAt.toISOString() : null,
    expiresAtMs: waiting ? expiresAt.getTime() : null,
    expiresText: waiting ? countdownText(expiresAt, now) : null,
    expiresAt: expiresAt ? formatInstant(expiresAt, snap.timezone) : null,
    instantBook: Boolean(snap.instantBook),
  };
}

/**
 * Pending requests first (soonest deadline first), then confirmed stays that
 * are not over (soonest check-in first), each with a guest summary: name,
 * member since, and how many stays that guest has completed with this host.
 */
/**
 * The two inbox lists as data (filter and sort). The query-plan review
 * (src/services/queryPlans.js) reads these, so what is checked against the
 * indexes is what the inbox runs.
 */
function inboxQueries(hostId, today) {
  return {
    pending: {
      filter: { host: hostId, status: "pending" },
      sort: { holdExpiresAt: 1, _id: 1 },
    },
    confirmed: {
      filter: { host: hostId, status: "confirmed", checkOut: { $gt: today } },
      sort: { checkIn: 1, _id: 1 },
    },
  };
}

async function listInbox(
  { ReservationModel = require("../models/reservation") } = {},
  hostId,
  { now = new Date() } = {},
) {
  const today = todayIn(DEFAULT_TIMEZONE, now);
  const populateGuest = "displayName username createdAt";
  const queries = inboxQueries(hostId, today);
  const [pendingRows, confirmedRows] = await Promise.all([
    ReservationModel.find(queries.pending.filter)
      .sort(queries.pending.sort)
      .limit(LIMIT + 1)
      .populate("guest", populateGuest)
      .lean(),
    ReservationModel.find(queries.confirmed.filter)
      .sort(queries.confirmed.sort)
      .limit(LIMIT + 1)
      .populate("guest", populateGuest)
      .lean(),
  ]);

  const rows = [
    ...pendingRows.slice(0, LIMIT),
    ...confirmedRows.slice(0, LIMIT),
  ];
  const guestIds = [...new Set(rows.map((r) => idText(r.guest)))];
  const previousStays = new Map();
  if (guestIds.length > 0) {
    const grouped = await ReservationModel.aggregate([
      {
        $match: {
          host: hostId,
          status: "completed",
          guest: { $in: rows.map((r) => (r.guest && r.guest._id) || r.guest) },
        },
      },
      { $group: { _id: "$guest", count: { $sum: 1 } } },
    ]);
    for (const g of grouped) previousStays.set(String(g._id), g.count);
  }

  return {
    pending: pendingRows
      .slice(0, LIMIT)
      .map((r) => describeInboxRow(r, { previousStays, now })),
    confirmed: confirmedRows
      .slice(0, LIMIT)
      .map((r) => describeInboxRow(r, { previousStays, now })),
    truncated: pendingRows.length > LIMIT || confirmedRows.length > LIMIT,
    limit: LIMIT,
  };
}

/**
 * Accept or decline one request as its host.
 * - 404 when the booking does not exist or is not this user's to answer (the
 *   same answer for both);
 * - accepting needs a live listing that is not suspended (409 listing_suspended);
 *   declining is always possible, so a host can clear a request on a listing
 *   that was taken down;
 * - an expired request cannot be accepted (409 hold_expired) and one already
 *   answered gives the status that won (409), both from `transition`.
 */
async function respond(
  {
    ReservationModel = require("../models/reservation"),
    ListingModel = require("../models/listing"),
    reservationService = require("./reservations"),
  } = {},
  { id, user, decision, reason, now = new Date() },
) {
  if (decision !== "accept" && decision !== "decline")
    throw new TypeError("decision must be accept or decline");
  const note = decision === "decline" ? parseReason(reason) : "";
  const reservation = OBJECT_ID.test(String(id))
    ? await ReservationModel.findById(id)
    : null;
  if (!reservation || !can("reservation:respond", user, reservation)) {
    throw new NotFoundError("That booking request does not exist.");
  }

  if (decision === "accept") {
    const listing = await ListingModel.findById(reservation.listing).select(
      "status deletedAt",
    );
    if (!listing || listing.deletedAt || listing.status === "suspended") {
      throw new ConflictError(
        "This listing is suspended or no longer exists, so the request cannot be accepted. You can still decline it.",
        { code: "listing_suspended" },
      );
    }
  }

  return reservationService.transition(
    reservation._id,
    decision === "accept" ? "confirmed" : "declined",
    {
      actor: "host",
      by: user._id,
      reason: note || undefined,
      now,
    },
  );
}

module.exports = {
  listInbox,
  inboxQueries,
  respond,
  parseReason,
  countdownText,
  describeInboxRow,
  REASON_MAX,
  LIMIT,
};
