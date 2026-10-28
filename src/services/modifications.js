// Changing the dates of a booking (P09-T04).
//
//   previewChange({ id, user, in, out, now })   what the new stay would cost; changes nothing
//   changeDates({ id, user, in, out, expectedTotalMinor, now })   does it
//
// Who and when: only the guest of the booking (policy `reservation:modify`;
// everybody else gets the same 404 as for a booking that does not exist), while
// the booking is `pending` (hold still running) or `confirmed` and the stay has
// not started (check-in moment on the listing's own clock). Guests stay the
// same: this changes the dates only.
//
// The new stay goes through the SAME rules and the SAME pricing as a new
// booking (bookingRules.js, pricing.quote), measured today: the price of the
// new dates is today's price of the place, and the difference is
// `new total - old total` (negative = cheaper). The difference is CALCULATED
// AND RECORDED in `Reservation.modifications`; no money moves (payments are
// simulated, P16).
//
// Order, which is what keeps the ledger honest (ADR-004). The unique
// (listing, date) index would refuse a night the booking already holds, so the
// ledger is changed by the DIFFERENCE between old and new nights:
//   1. hold the nights that are new (added = new \ old), all or nothing. On a
//      conflict nothing was written and the booking is exactly as before.
//   2. pending only: move the hold of the kept nights to the new answer time.
//   3. compare-and-set the reservation (status, old dates and, for a pending
//      request, a still-running hold must be what we read). Only one of two
//      concurrent changes, or a change and a cancel/accept/expiry, can win.
//      The loser releases exactly the nights it added in step 1.
//   4. release the nights given up (trim to exactly the new nights).
// A night is therefore never free while the booking still needs it, and no
// state exists in which two bookings own the same night. If step 4 fails the
// old nights stay blocked (the safe side) and `trimNights` can be run again.
//
// A pending request goes back to the host: the hold restarts for 24 hours and
// the host is told (`reservation.modified`), so the host answers the NEW dates.
// A confirmed stay on a place that asks for approval keeps its confirmation:
// the host already accepted this guest for this place; they are told of the
// new dates and can cancel. (Known limit, see docs/tasks/P09-T04.md.)
const { can } = require("../policies");
const {
  tryParseDateOnly,
  eachNight,
  formatDateOnly,
  instantAfter,
} = require("../utils/dates");
const {
  NotFoundError,
  ValidationError,
  ConflictError,
  PriceChangedError,
} = require("../utils/errors");
const { isPublic } = require("../utils/visibility");
const { bookingProblems } = require("./bookingRules");
const { checkInInstant } = require("./refunds");

const { PENDING_HOLD_MS } = require("./reservations");

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const keyOf = (date) => date.getTime();

/**
 * Can this booking's dates still be changed? Pure.
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function modifiability(reservation, now = new Date()) {
  const status = reservation && reservation.status;
  if (status !== "pending" && status !== "confirmed") {
    return {
      ok: false,
      code: "not_modifiable",
      message: "Only a request that is waiting for the host or a confirmed stay can be changed.",
    };
  }
  if (
    status === "pending" &&
    !(reservation.holdExpiresAt && reservation.holdExpiresAt.getTime() > now.getTime())
  ) {
    return {
      ok: false,
      code: "hold_expired",
      message: "This request has expired, so its dates can no longer be changed.",
    };
  }
  if (now.getTime() >= checkInInstant(reservation).getTime()) {
    return {
      ok: false,
      code: "stay_started",
      message: "This stay has already started, so its dates can no longer be changed.",
    };
  }
  return { ok: true };
}

/** The nights to add and the nights to give up when going from one stay to another. */
function diffNights(oldIn, oldOut, newIn, newOut) {
  const before = eachNight(oldIn, oldOut);
  const after = eachNight(newIn, newOut);
  const had = new Set(before.map(keyOf));
  const wants = new Set(after.map(keyOf));
  return {
    before,
    after,
    added: after.filter((n) => !had.has(keyOf(n))),
    removed: before.filter((n) => !wants.has(keyOf(n))),
  };
}

function parseStay(inRaw, outRaw) {
  const checkIn = typeof inRaw === "string" ? tryParseDateOnly(inRaw) : null;
  const checkOut = typeof outRaw === "string" ? tryParseDateOnly(outRaw) : null;
  if (!checkIn || !checkOut) {
    return {
      problem: {
        code: "invalid_dates",
        message: "Choose a check-in and a check-out date.",
      },
    };
  }
  return { checkIn, checkOut };
}

/**
 * @param {object} [deps] replaceable in tests
 */
function createModificationService({
  ReservationModel = require("../models/reservation"),
  ListingModel = require("../models/listing"),
  ledgerService = require("./ledger"),
  pricing = require("./pricing"),
  notifier = null,
  logger = null,
} = {}) {
  async function tell(event, reservation) {
    if (!notifier) return;
    try {
      await notifier.dispatch(event, { reservation });
    } catch {
      // a notification is a courtesy; dispatch already swallows its own errors
    }
  }

  // The reservation this person may change, or the 404 everyone else gets.
  async function load(id, user) {
    const reservation = OBJECT_ID.test(String(id)) ? await ReservationModel.findById(id) : null;
    if (!reservation || !can("reservation:modify", user, reservation)) {
      throw new NotFoundError("That booking does not exist.");
    }
    return reservation;
  }

  async function loadListing(reservation) {
    const listing = await ListingModel.findById(reservation.listing);
    if (!listing || !isPublic(listing)) {
      throw new ConflictError(
        "This place is not open for bookings at the moment, so the dates cannot be changed.",
        { code: "listing_unavailable" },
      );
    }
    return listing;
  }

  // Everything that can be known without writing: the rules, the nights taken
  // by someone ELSE (the booking's own nights do not count against it) and the
  // price. `problems` is empty exactly when the change may be tried.
  async function evaluate(reservation, listing, { checkIn, checkOut }, now) {
    const problems = [];
    if (
      formatDateOnly(checkIn) === formatDateOnly(reservation.checkIn) &&
      formatDateOnly(checkOut) === formatDateOnly(reservation.checkOut)
    ) {
      problems.push({ code: "no_change", message: "These are the dates you already have." });
    }
    if (!problems.length) {
      problems.push(
        ...bookingProblems({ listing, checkIn, checkOut, guests: reservation.guests, now }),
      );
    }
    if (!problems.length) {
      const own = new Set(eachNight(reservation.checkIn, reservation.checkOut).map(keyOf));
      const taken = (
        await ledgerService.unavailableDates(listing._id, checkIn, checkOut, { now })
      ).filter((night) => !own.has(keyOf(night)));
      if (taken.length) {
        problems.push({
          code: "nights_unavailable",
          message: `These nights are not available: ${taken.map(formatDateOnly).join(", ")}.`,
        });
      }
    }
    if (problems.length) return { problems, quote: null, differenceMinor: null };

    // QuoteRefusedError (422) when the place has no valid price any more.
    const quote = pricing.quote({ listing, checkIn, checkOut, guests: reservation.guests });
    const old = reservation.pricingSnapshot || {};
    if (old.currency && quote.currency !== old.currency) {
      return {
        problems: [
          {
            code: "currency_changed",
            message: "The price of this place is now in a different currency, so the dates cannot be changed. Please cancel and book again.",
          },
        ],
        quote: null,
        differenceMinor: null,
      };
    }
    return { problems: [], quote, differenceMinor: quote.totalMinor - old.totalMinor };
  }

  /**
   * What changing to these dates would mean, without changing anything. A
   * booking that cannot be changed is a 409; wrong dates come back as
   * `problems` (so the page can show them next to the form).
   * @returns {Promise<{ reservation, listing, requested: boolean, problems: object[],
   *   checkIn?: Date, checkOut?: Date, quote: object|null, differenceMinor: number|null,
   *   reapproval: boolean }>}
   */
  async function previewChange({ id, user, in: inRaw, out: outRaw, now = new Date() }) {
    const reservation = await load(id, user);
    const state = modifiability(reservation, now);
    if (!state.ok) throw new ConflictError(state.message, { code: state.code });
    const listing = await loadListing(reservation);
    const base = {
      reservation,
      listing,
      reapproval: reservation.status === "pending",
      quote: null,
      differenceMinor: null,
    };
    const asked = inRaw !== undefined || outRaw !== undefined;
    if (!asked) return { ...base, requested: false, problems: [] };

    const stay = parseStay(inRaw, outRaw);
    if (stay.problem) return { ...base, requested: true, problems: [stay.problem] };
    const result = await evaluate(reservation, listing, stay, now);
    return {
      ...base,
      requested: true,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      ...result,
    };
  }

  /**
   * Moves the stay. @throws NotFoundError 404 (not yours / missing),
   *   ConflictError 409 (not_modifiable, hold_expired, stay_started,
   *   listing_unavailable, nights_unavailable, conflict), ValidationError 400
   *   (rule code or no_change / invalid_dates), PriceChangedError 409,
   *   QuoteRefusedError 422
   * @returns {Promise<{ reservation: object, quote: object, differenceMinor: number, reapproval: boolean }>}
   */
  async function changeDates({
    id,
    user,
    in: inRaw,
    out: outRaw,
    expectedTotalMinor,
    now = new Date(),
  }) {
    const reservation = await load(id, user);
    const state = modifiability(reservation, now);
    if (!state.ok) throw new ConflictError(state.message, { code: state.code });
    const listing = await loadListing(reservation);

    const stay = parseStay(inRaw, outRaw);
    if (stay.problem) throw new ValidationError(stay.problem.message, { code: stay.problem.code });
    const { checkIn, checkOut } = stay;

    const result = await evaluate(reservation, listing, stay, now);
    if (result.problems.length) {
      const first = result.problems[0];
      if (first.code === "nights_unavailable") {
        throw new ConflictError(first.message, { code: "nights_unavailable" });
      }
      throw new ValidationError(first.message, { code: first.code });
    }
    const { quote, differenceMinor } = result;

    // The price the guest looked at must be the price that is stored.
    let expected = null;
    if (expectedTotalMinor !== undefined && expectedTotalMinor !== null && expectedTotalMinor !== "") {
      expected =
        typeof expectedTotalMinor === "string" && /^\d{1,15}$/.test(expectedTotalMinor)
          ? Number(expectedTotalMinor)
          : expectedTotalMinor;
      if (!Number.isSafeInteger(expected) || expected < 0) {
        throw new ValidationError("The expected total must be a whole number of paise.");
      }
    }
    if (expected !== null && expected !== quote.totalMinor) throw new PriceChangedError(quote);

    const pending = reservation.status === "pending";
    const newHold = pending ? instantAfter(now, PENDING_HOLD_MS) : null;
    const { after, added } = diffNights(
      reservation.checkIn,
      reservation.checkOut,
      checkIn,
      checkOut,
    );
    const source = { kind: "reservation", id: reservation._id };

    // 1. Hold the new nights first. A conflict leaves everything as it was.
    if (added.length) {
      await ledgerService.reserveNights(listing._id, added, source, newHold, { now });
    }
    const undo = async () => {
      if (!added.length) return;
      try {
        await ledgerService.releaseNightsOn(reservation._id, added);
      } catch (err) {
        // Rows of a live booking outside its dates: the sweeper cannot see
        // them, but they only block (never double-book) those nights.
        if (logger) {
          logger.error(
            { err, reservation: String(reservation._id) },
            "nights added by a failed date change were not released",
          );
        }
      }
    };

    let updated;
    try {
      // 2. The kept nights of a pending request get the new answer time too.
      if (pending) await ledgerService.extendHold(reservation._id, newHold, { now });

      // 3. One winner.
      const old = reservation.pricingSnapshot || {};
      const entry = {
        from: reservation.status,
        to: reservation.status,
        at: now,
        actor: "guest",
        by: user._id,
        note: `dates changed from ${formatDateOnly(reservation.checkIn)} - ${formatDateOnly(reservation.checkOut)} to ${formatDateOnly(checkIn)} - ${formatDateOnly(checkOut)}`,
      };
      updated = await ReservationModel.findOneAndUpdate(
        {
          _id: reservation._id,
          status: reservation.status,
          checkIn: reservation.checkIn,
          checkOut: reservation.checkOut,
          ...(pending ? { holdExpiresAt: { $gt: now } } : {}),
        },
        {
          $set: {
            checkIn,
            checkOut,
            nights: quote.nights,
            pricingSnapshot: quote,
            ...(pending ? { holdExpiresAt: newHold } : {}),
          },
          $push: {
            statusHistory: entry,
            modifications: {
              at: now,
              by: user._id,
              from: {
                checkIn: reservation.checkIn,
                checkOut: reservation.checkOut,
                nights: reservation.nights,
                totalMinor: old.totalMinor,
              },
              to: { checkIn, checkOut, nights: quote.nights, totalMinor: quote.totalMinor },
              differenceMinor,
              currency: quote.currency,
              reapproval: pending,
            },
          },
        },
        { new: true },
      );
    } catch (err) {
      await undo();
      throw err;
    }
    if (!updated) {
      await undo();
      throw new ConflictError("That booking changed. Please reload and try again.", {
        code: "conflict",
      });
    }

    // 4. Give up the old nights. Idempotent: if it fails the nights only stay
    // blocked, and running it again repairs it.
    try {
      await ledgerService.trimNights(reservation._id, after);
    } catch (err) {
      if (logger) {
        logger.error(
          { err, reservation: String(reservation._id) },
          "nights given up by a date change were not released",
        );
      }
    }

    await tell("reservation.modified", updated);
    return { reservation: updated, quote, differenceMinor, reapproval: pending };
  }

  return { previewChange, changeDates };
}

/**
 * Words for the price difference. Pure.
 * @returns {{ kind: "more"|"less"|"same", text: string, amountText: string }}
 */
function describeDifference(differenceMinor, { formatMoney, currency }) {
  const amountText = formatMoney(Math.abs(differenceMinor), currency);
  if (differenceMinor > 0) {
    return { kind: "more", amountText, text: `The new stay costs ${amountText} more.` };
  }
  if (differenceMinor < 0) {
    return { kind: "less", amountText, text: `The new stay costs ${amountText} less.` };
  }
  return { kind: "same", amountText, text: "The new stay costs the same." };
}

module.exports = {
  ...createModificationService({
    notifier: require("./notificationEvents").notifier,
  }),
  createModificationService,
  modifiability,
  diffNights,
  describeDifference,
};
