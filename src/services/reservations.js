// Reservations (P07-T05): creating a booking and changing its status.
//
//   create({ guest, listing, in, out, guests, expectedTotalMinor, idempotencyKey })
//   transition(reservationId, to, { actor, by, reason, now }?)
//
// create() order, which is what keeps the ledger and the reservations
// consistent (ADR-004):
//   1. validate input; a repeated idempotency key returns the original
//   2. load the listing; booking rules (bookingRules.js); quote; compare the price the guest saw
//   3. hold every night in the ledger (the database refuses a second owner)
//   4. check the listing is still public (a host may unpublish meanwhile)
//   5. insert the reservation; if that fails, release the nights
// So a reservation never exists without its nights; a night without a live
// reservation can only remain if step 5's cleanup itself fails (the sweeper,
// P07-T07, removes such orphans).
//
// transition() is compare-and-set: the update only matches while the status is
// still the one that was read, so "host accepts while guest cancels" has one
// winner and the other gets a 409.
const { isActiveUser, sameId, idOf } = require("../policies/shared");
const {
  DEFAULT_TIMEZONE,
  tryParseDateOnly,
  isDateOnly,
  todayIn,
  eachNight,
  formatDateOnly,
  instantAfter,
} = require("../utils/dates");
const {
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PriceChangedError,
} = require("../utils/errors");
const { isPublic } = require("../utils/visibility");
const { bookingProblems } = require("./bookingRules");
const { assertTransition, releasesNights } = require("./stateMachine");

const PENDING_HOLD_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const isDuplicateKey = (err) =>
  Boolean(err) &&
  (err.code === 11000 ||
    [].concat(err.writeErrors || []).some((e) => e && e.code === 11000));

function toDate(value, label) {
  if (isDateOnly(value)) return value;
  const date = typeof value === "string" ? tryParseDateOnly(value) : null;
  if (!date) {
    throw new ValidationError(`${label} must be a valid date in YYYY-MM-DD format.`);
  }
  return date;
}

function parseGuests(value) {
  const n = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError("Guests must be a whole number, 1 or more.");
  }
  return n;
}

function parseExpected(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ValidationError("The expected total must be a whole number of paise.");
  }
  return n;
}

function parseKey(value) {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new ValidationError(
      "A booking needs an idempotency key of 8 to 64 letters, digits, - or _.",
    );
  }
  return value;
}

const lineDate = (d) => formatDateOnly(d);

/**
 * @param {object} [deps] replaceable in unit tests
 */
function createReservationService({
  ReservationModel = require("../models/reservation"),
  ListingModel = require("../models/listing"),
  ledgerService = require("./ledger"),
  pricing = require("./pricing"),
  newId = () => new (require("mongoose").Types.ObjectId)(),
  replayRetries = 5,
  replayDelayMs = 40,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const sameRequest = (reservation, wanted) =>
    sameId(reservation.listing, wanted.listing) &&
    lineDate(reservation.checkIn) === lineDate(wanted.checkIn) &&
    lineDate(reservation.checkOut) === lineDate(wanted.checkOut) &&
    reservation.guests === wanted.guests;

  function replayOf(reservation, wanted) {
    if (!sameRequest(reservation, wanted)) {
      throw new ConflictError(
        "That booking key was already used for a different stay. Please start the booking again.",
        { code: "idempotency_key_reused" },
      );
    }
    return { reservation, created: false };
  }

  // The first request may still be between "nights held" and "reservation
  // saved" when its twin arrives (double click): wait briefly for it.
  async function waitForOriginal(guestId, key) {
    for (let attempt = 0; attempt < replayRetries; attempt += 1) {
      const found = await ReservationModel.findOne({ guest: guestId, idempotencyKey: key });
      if (found) return found;
      await sleep(replayDelayMs);
    }
    return null;
  }

  async function releaseQuietly(id) {
    try {
      await ledgerService.releaseNights(id);
    } catch {
      // Orphaned rows are removed by the sweeper (P07-T07); the original error
      // is the one the caller must see.
    }
  }

  /**
   * @returns {Promise<{reservation: object, created: boolean}>}
   * @throws ValidationError 400, ForbiddenError 403, NotFoundError 404,
   *   ConflictError 409 (nights_unavailable, idempotency_key_reused),
   *   PriceChangedError 409 (price_changed, carries `.quote`),
   *   QuoteRefusedError 422
   */
  async function create(input, { now = new Date() } = {}) {
    const { guest, listing: listingRef, in: inRaw, out: outRaw } = input || {};
    const key = parseKey(input && input.idempotencyKey);
    if (!isActiveUser(guest)) {
      throw new ForbiddenError("Your account cannot make bookings.");
    }
    const listingId = idOf(listingRef);
    if (!listingId) throw new NotFoundError("That place is not available for booking.");
    const checkIn = toDate(inRaw, "Check-in");
    const checkOut = toDate(outRaw, "Check-out");
    const guests = parseGuests(input.guests);
    const expectedTotalMinor = parseExpected(input.expectedTotalMinor);
    const wanted = { listing: listingId, checkIn, checkOut, guests };

    const earlier = await ReservationModel.findOne({ guest: guest._id, idempotencyKey: key });
    if (earlier) return replayOf(earlier, wanted);

    const listing = await ListingModel.findById(listingId);
    if (!listing || !isPublic(listing) || !listing.owner) {
      throw new NotFoundError("That place is not available for booking.");
    }
    if (sameId(listing.owner, guest._id)) {
      throw new ForbiddenError("You cannot book your own listing.");
    }

    // Booking rules (P07-T06): one module decides dates, stay length,
    // capacity, advance notice and the same-day cut-off, each with its own
    // message and code. The first problem is the one the guest sees.
    const problems = bookingProblems({ listing, checkIn, checkOut, guests, now });
    if (problems.length) {
      throw new ValidationError(problems[0].message, { code: problems[0].code });
    }

    const quote = pricing.quote({ listing, checkIn, checkOut, guests });
    if (expectedTotalMinor !== null && expectedTotalMinor !== quote.totalMinor) {
      throw new PriceChangedError(quote);
    }

    const instant = Boolean(listing.instantBook);
    const status = instant ? "confirmed" : "pending";
    const holdExpiresAt = instant ? null : instantAfter(now, PENDING_HOLD_MS);
    const _id = newId();

    try {
      await ledgerService.reserveNights(
        listing._id,
        eachNight(checkIn, checkOut),
        { kind: "reservation", id: _id },
        holdExpiresAt,
        { now },
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        const original = await waitForOriginal(guest._id, key);
        if (original) return replayOf(original, wanted);
      }
      throw err;
    }

    // The host may have unpublished or deleted the listing meanwhile.
    let stillPublic = false;
    try {
      stillPublic = isPublic(await ListingModel.findById(listing._id).select("status deletedAt"));
    } catch (err) {
      await releaseQuietly(_id);
      throw err;
    }
    if (!stillPublic) {
      await releaseQuietly(_id);
      throw new NotFoundError("That place is not available for booking.");
    }

    const cover =
      (Array.isArray(listing.images) && listing.images[0] && listing.images[0].url) ||
      (listing.image && listing.image.url) ||
      undefined;
    try {
      const reservation = await ReservationModel.create({
        _id,
        listing: listing._id,
        guest: guest._id,
        host: listing.owner,
        checkIn,
        checkOut,
        nights: quote.nights,
        guests,
        status,
        ...(holdExpiresAt ? { holdExpiresAt } : {}),
        statusHistory: [
          { from: null, to: status, at: now, actor: "guest", by: guest._id, note: instant ? "instant booking" : "request sent" },
        ],
        pricingSnapshot: quote,
        listingSnapshot: {
          title: listing.title,
          city: listing.address && listing.address.city,
          coverUrl: cover,
          houseRules: listing.houseRules,
          noSpecialRules: Boolean(listing.noSpecialRules),
          cancellationPolicy: listing.cancellationPolicy,
          checkInTime: listing.checkInTime,
          checkOutTime: listing.checkOutTime,
          timezone: listing.timezone || DEFAULT_TIMEZONE,
          instantBook: instant,
        },
        idempotencyKey: key,
      });
      return { reservation, created: true };
    } catch (err) {
      await releaseQuietly(_id);
      if (isDuplicateKey(err)) {
        // A twin request saved first: its reservation (and nights) stand.
        const original = await ReservationModel.findOne({ guest: guest._id, idempotencyKey: key });
        if (original) return replayOf(original, wanted);
      }
      throw err;
    }
  }

  // Extra conditions that make a transition valid only at the right time, and
  // the error when the update did not match although the status did.
  function guardFor(to, current, now) {
    if (to === "confirmed") {
      return {
        filter: { holdExpiresAt: { $gt: now } },
        onMiss: () =>
          new ConflictError("This request has expired and can no longer be accepted.", { code: "hold_expired" }),
      };
    }
    if (to === "expired") {
      return {
        filter: { holdExpiresAt: { $lte: now } },
        onMiss: () => new ConflictError("This request has not expired yet.", { code: "hold_active" }),
      };
    }
    if (to === "completed") {
      const tz = (current.listingSnapshot && current.listingSnapshot.timezone) || DEFAULT_TIMEZONE;
      return {
        filter: { checkOut: { $lte: todayIn(tz, now) } },
        onMiss: () => new ConflictError("The stay is not over yet.", { code: "stay_not_over" }),
      };
    }
    return { filter: {}, onMiss: null };
  }

  /**
   * Moves a reservation to `to`. `actor` is "guest", "host" or "system"; who
   * the caller really is (policy) is checked by the caller.
   * @returns {Promise<object>} the updated reservation
   */
  async function transition(reservationId, to, { actor, by, reason, refund, expectStatus, now = new Date() } = {}) {
    const current = await ReservationModel.findById(reservationId);
    if (!current) throw new NotFoundError("That reservation does not exist.");
    // The caller worked something out (a refund) from this status: if the
    // booking has moved on since, say so instead of applying a stale result.
    if (expectStatus && current.status !== expectStatus) {
      throw new ConflictError("That booking changed. Please reload and try again.", { code: "conflict" });
    }
    assertTransition(current.status, to, actor);

    const guard = guardFor(to, current, now);
    const set = { status: to };
    const unset = {};
    if (to === "confirmed" || releasesNights(to) || to === "completed") unset.holdExpiresAt = 1;
    if (to === "cancelled_by_guest" || to === "cancelled_by_host") {
      set.cancelledBy = actor;
      if (reason) set.cancelReason = String(reason).slice(0, 500);
      // The refund is stored by the same compare-and-set that cancels, so a
      // cancelled booking always has the amount that was worked out for it.
      if (refund) {
        set.refund = {
          amountMinor: refund.refundMinor,
          retainedMinor: refund.retainedMinor,
          totalMinor: refund.totalMinor,
          currency: current.pricingSnapshot && current.pricingSnapshot.currency,
          policy: refund.policy || undefined,
          rule: refund.rule,
          calculatedAt: now,
        };
      }
    }
    const entry = { from: current.status, to, at: now, actor, ...(by ? { by } : {}), ...(reason ? { note: String(reason).slice(0, 500) } : {}) };

    const updated = await ReservationModel.findOneAndUpdate(
      { _id: current._id, status: current.status, ...guard.filter },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $push: { statusHistory: entry } },
      { new: true },
    );
    if (!updated) {
      const latest = await ReservationModel.findById(current._id);
      if (latest && latest.status === current.status && guard.onMiss) throw guard.onMiss();
      assertTransition(latest ? latest.status : current.status, to, actor); // names the status that won
      throw new ConflictError("That reservation changed. Please reload and try again.", { code: "conflict" });
    }

    if (to === "confirmed") await ledgerService.confirmNights(updated._id);
    else if (releasesNights(to)) await ledgerService.releaseNights(updated._id);
    return updated;
  }

  return { create, transition };
}

module.exports = {
  ...createReservationService(),
  createReservationService,
  PENDING_HOLD_MS,
};
