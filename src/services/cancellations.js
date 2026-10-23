// Cancelling a booking (P09-T03): the guest's and the host's cancel flows.
//
// - The guest may cancel a pending request (free) or a confirmed booking
//   (refund by the listing's policy, src/services/refunds.js).
// - The host may cancel a CONFIRMED booking (a pending request is declined, not
//   cancelled): the guest always gets everything back, a reason is required,
//   and the host's cancellation counter goes up by one.
// - Who is cancelling comes from who the person is (guest or host of THIS
//   booking), never from the form. Anybody else gets the same 404 as for a
//   booking that does not exist.
//
// The refund is worked out here and stored by the same compare-and-set that
// changes the status (reservations.transition), so a cancelled booking always
// carries its refund, and two cancellations at once leave exactly one winner.
// Nothing is paid back: payments are simulated (P16 acts on the record).
const { can } = require("../policies");
const { sameId } = require("../policies/shared");
const { refundForCancellation } = require("./refunds");
const { parseReason } = require("../utils/reason");
const { todayIn, DEFAULT_TIMEZONE } = require("../utils/dates");
const {
  NotFoundError,
  ValidationError,
  ConflictError,
} = require("../utils/errors");

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const actorOf = (reservation, user) =>
  sameId(reservation.guest, user._id) ? "guest" : "host";

/**
 * Can this side cancel this booking right now? Pure.
 * guest: pending or confirmed; host: confirmed only. Never once the stay is over.
 */
function mayCancel(reservation, actor, now) {
  const allowed = actor === "guest" ? ["pending", "confirmed"] : ["confirmed"];
  if (!allowed.includes(reservation.status)) return false;
  const tz =
    (reservation.listingSnapshot && reservation.listingSnapshot.timezone) ||
    DEFAULT_TIMEZONE;
  return todayIn(tz, now).getTime() < reservation.checkOut.getTime();
}

/**
 * What the booking page shows next to the cancel button: whether the viewer
 * may cancel and what they would get back if they cancelled now. Pure.
 * @param {object} reservation
 * @param {{ actor: "guest"|"host", now: Date, formatMoney: Function, formatInstant: Function }} options
 * @returns {object|null} null when there is nothing to offer
 */
function cancelOffer(reservation, { actor, now, formatMoney, formatInstant }) {
  if (!mayCancel(reservation, actor, now)) return null;
  const refund = refundForCancellation({ reservation, actor, now });
  const currency =
    (reservation.pricingSnapshot && reservation.pricingSnapshot.currency) ||
    "INR";
  const snap = reservation.listingSnapshot || {};
  return {
    actor,
    refundMinor: refund.refundMinor,
    refundText: formatMoney(refund.refundMinor, currency),
    keptText: formatMoney(refund.retainedMinor, currency),
    totalText: formatMoney(refund.totalMinor, currency),
    full: refund.refundMinor === refund.totalMinor,
    ruleText: refund.ruleText,
    freeUntilText: refund.fullRefundUntil
      ? formatInstant(refund.fullRefundUntil, snap.timezone)
      : null,
    reasonRequired: actor === "host",
  };
}

/**
 * @param {object} deps replaceable in tests (defaults load the real models)
 * @param {{ id: string, user: object, reason?: string, now?: Date }} input
 * @returns {Promise<{ reservation: object, refund: object, actor: string }>}
 */
async function cancelBooking(
  {
    ReservationModel = require("../models/reservation"),
    UserModel = require("../models/user"),
    reservationService = require("./reservations"),
    logger,
  } = {},
  { id, user, reason, now = new Date() },
) {
  const reservation = OBJECT_ID.test(String(id))
    ? await ReservationModel.findById(id)
    : null;
  if (!reservation || !can("reservation:cancel", user, reservation)) {
    throw new NotFoundError("That booking does not exist.");
  }
  const actor = actorOf(reservation, user);
  const note = parseReason(reason);
  if (actor === "host" && !note) {
    throw new ValidationError("Please tell the guest why you are cancelling.");
  }
  if (actor === "host" && reservation.status === "pending") {
    throw new ConflictError(
      "This request has not been accepted yet: decline it instead of cancelling it.",
      {
        code: "use_decline",
      },
    );
  }
  if (!mayCancel(reservation, actor, now)) {
    throw new ConflictError(
      reservation.status === "confirmed" || reservation.status === "pending"
        ? "This stay is already over, so it can no longer be cancelled."
        : "This booking can no longer be cancelled.",
      { code: "not_cancellable" },
    );
  }

  const refund = refundForCancellation({ reservation, actor, now });
  const updated = await reservationService.transition(
    reservation._id,
    actor === "guest" ? "cancelled_by_guest" : "cancelled_by_host",
    {
      actor,
      by: user._id,
      reason: note || undefined,
      refund,
      expectStatus: reservation.status,
      now,
    },
  );

  if (actor === "host") {
    // The cancellation is done and cannot be undone: a failure to count it is
    // reported, never turned into an error for the host.
    try {
      await UserModel.updateOne(
        { _id: reservation.host },
        { $inc: { hostCancellationCount: 1 } },
      );
    } catch (err) {
      if (logger)
        logger.error(
          { err, reservation: String(reservation._id) },
          "host cancellation counter not updated",
        );
    }
  }
  return { reservation: updated, refund, actor };
}

module.exports = { cancelBooking, cancelOffer, mayCancel };
