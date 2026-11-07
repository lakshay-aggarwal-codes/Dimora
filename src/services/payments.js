// Simulated payments (P16-T01, ADR-009).
//
//   pay({ reservationId, guest, idempotencyKey, outcome?, now? })
//   refundRelease(reservation, { amountMinor?, reason?, now? })
//
// A booking made while simulated payments are on starts `awaiting_payment`
// with its nights held for a short time. pay() is the guest pressing "Pay
// (simulated)":
//   - the attempt is stored first (PaymentAttempt, a unique key per button
//     page, at most one live charge per booking), so a double click or two tabs
//     cannot make two charges;
//   - the provider answers (services/paymentProviders/simulated.js; nothing
//     moves, no card data exists);
//   - ONLY on success does the booking move on, through the reservation
//     service's compare-and-set: confirmed (instant book) or pending (the host
//     still answers). A refusal changes nothing on the booking: its nights stay
//     held until the payment hold ends and the sweeper expires it.
// refundRelease() records `refunded_simulated` when a paid booking ends
// without a stay (declined, expired, cancelled). Once per booking.
const { isActiveUser, sameId } = require("../policies/shared");
const {
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
// A pending attempt this old never finished (the process died between storing
// it and hearing the provider); it stops blocking a new try.
const STALE_PENDING_MS = 30 * 1000;

const isDuplicateKey = (err) =>
  Boolean(err) &&
  (err.code === 11000 ||
    [].concat(err.writeErrors || []).some((e) => e && e.code === 11000));

const FAILURE_MESSAGES = Object.freeze({
  declined: "The simulated payment was declined.",
  service_error: "The simulated payment service did not answer.",
  hold_expired: "The time to pay for this booking ran out.",
  abandoned: "An earlier payment try never finished.",
  internal_error: "The payment could not be completed.",
});
const messageFor = (code) =>
  FAILURE_MESSAGES[code] || "The simulated payment did not go through.";

function createPaymentService({
  AttemptModel = require("../models/paymentAttempt"),
  ReservationModel = require("../models/reservation"),
  reservationService = require("./reservations"),
  provider = require("./paymentProviders/simulated"),
  staleMs = STALE_PENDING_MS,
} = {}) {
  function parseKey(value) {
    if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
      throw new ValidationError(
        "A payment needs a key of 8 to 64 letters, digits, - or _.",
      );
    }
    return value;
  }

  const outcomes = provider.OUTCOMES || ["success", "declined", "error"];

  /** What an attempt that already exists means for the caller. */
  function resultOf(attempt) {
    if (attempt.status === "succeeded") {
      return { ok: true, status: "paid", replay: true, attempt };
    }
    if (attempt.status === "failed") {
      return {
        ok: false,
        status: "failed",
        replay: true,
        attempt,
        failureCode: attempt.failureCode,
        message: messageFor(attempt.failureCode),
      };
    }
    return {
      ok: false,
      status: "in_progress",
      replay: true,
      attempt,
      message: "This payment is already being processed.",
    };
  }

  async function finish(attempt, from, to, failureCode, now) {
    await AttemptModel.updateOne(
      { _id: attempt._id, status: from },
      {
        $set: {
          status: to,
          completedAt: now,
          ...(to === "failed" ? { live: false, failureCode } : {}),
        },
      },
    );
  }

  /**
   * @returns {Promise<{ ok: boolean, status: "paid"|"already_paid"|"failed"|"in_progress",
   *   attempt?: object, reservation?: object, failureCode?: string, message?: string, replay?: boolean }>}
   * @throws ValidationError 400, ForbiddenError 403, NotFoundError 404,
   *   ConflictError 409 (not_awaiting_payment, payment_hold_expired)
   */
  async function pay(input, { now = new Date() } = {}) {
    const { reservationId, guest } = input || {};
    const key = parseKey(input && input.idempotencyKey);
    const outcome = input.outcome === undefined ? "success" : input.outcome;
    if (!outcomes.includes(outcome)) {
      throw new ValidationError("That is not a payment outcome.");
    }
    if (!isActiveUser(guest)) {
      throw new ForbiddenError("Your account cannot make payments.");
    }
    const reservation = reservationId
      ? await ReservationModel.findById(reservationId)
      : null;
    // The same answer for "no such booking" and "someone else's booking".
    if (!reservation || !sameId(reservation.guest, guest._id)) {
      throw new NotFoundError("That booking does not exist.");
    }

    // A repeated key is the same click: answer what the first one did, even if
    // the booking has moved on since.
    const earlier = await AttemptModel.findOne({
      reservation: reservation._id,
      idempotencyKey: key,
    });
    if (earlier) return { ...resultOf(earlier), reservation };

    if (reservation.status !== "awaiting_payment") {
      if (reservation.paymentStatus === "simulated_paid") {
        return { ok: true, status: "already_paid", reservation };
      }
      throw new ConflictError("This booking is no longer waiting for payment.", {
        code: "not_awaiting_payment",
      });
    }
    if (!reservation.holdExpiresAt || reservation.holdExpiresAt.getTime() <= now.getTime()) {
      throw new ConflictError("The time to pay for this booking has run out.", {
        code: "payment_hold_expired",
      });
    }

    const price = reservation.pricingSnapshot || {};
    const attemptData = {
      reservation: reservation._id,
      guest: guest._id,
      provider: provider.name || "simulated",
      kind: "charge",
      status: "pending",
      amountMinor: price.totalMinor,
      currency: price.currency,
      idempotencyKey: key,
      requestedOutcome: outcome,
      live: true,
    };

    let attempt = null;
    for (let tries = 0; tries < 2 && !attempt; tries += 1) {
      try {
        attempt = await AttemptModel.create(attemptData);
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        // Same key: a twin click got there first. Another key: a live charge.
        const twin = await AttemptModel.findOne({
          reservation: reservation._id,
          idempotencyKey: key,
        });
        if (twin) return { ...resultOf(twin), reservation };
        const live = await AttemptModel.findOne({
          reservation: reservation._id,
          live: true,
        });
        if (live && live.status === "succeeded") {
          return { ok: true, status: "already_paid", attempt: live, reservation };
        }
        const abandoned =
          live &&
          live.status === "pending" &&
          live.createdAt &&
          now.getTime() - live.createdAt.getTime() > staleMs;
        if (abandoned && tries === 0) {
          await finish(live, "pending", "failed", "abandoned", now);
          continue;
        }
        return {
          ok: false,
          status: "in_progress",
          reservation,
          message: "A payment for this booking is already being processed.",
        };
      }
    }
    if (!attempt) {
      return {
        ok: false,
        status: "in_progress",
        reservation,
        message: "A payment for this booking is already being processed.",
      };
    }

    let result;
    try {
      result = await provider.charge({
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        outcome,
      });
    } catch (err) {
      if (err && err.code === "payment_service_error") {
        result = { status: "failed", failureCode: "service_error" };
      } else {
        await finish(attempt, "pending", "failed", "internal_error", now);
        throw err;
      }
    }

    if (result.status !== "succeeded") {
      const code = result.failureCode || "declined";
      await finish(attempt, "pending", "failed", code, now);
      return {
        ok: false,
        status: "failed",
        attempt,
        reservation,
        failureCode: code,
        message: messageFor(code),
      };
    }

    await finish(attempt, "pending", "succeeded", undefined, now);
    const to =
      reservation.listingSnapshot && reservation.listingSnapshot.instantBook
        ? "confirmed"
        : "pending";
    try {
      const updated = await reservationService.transition(reservation._id, to, {
        actor: "guest",
        by: guest._id,
        reason: "Simulated payment received.",
        expectStatus: "awaiting_payment",
        paymentStatus: "simulated_paid",
        now,
      });
      return { ok: true, status: "paid", attempt, reservation: updated };
    } catch (err) {
      // The hold ran out (the sweeper won) or the booking changed while the
      // provider answered. Nothing really moved: the attempt is voided and the
      // guest is told, rather than leaving a "paid" record on a dead booking.
      const code = err instanceof ConflictError ? "hold_expired" : "internal_error";
      await finish(attempt, "succeeded", "failed", code, now);
      if (err instanceof ConflictError) {
        return {
          ok: false,
          status: "failed",
          attempt,
          reservation,
          failureCode: code,
          message: messageFor(code),
        };
      }
      throw err;
    }
  }

  /**
   * Records `refunded_simulated` for a paid booking that ended without a stay.
   * Safe to call twice (one refund per booking). Nothing is returned for a
   * booking that was never paid, or when nothing is due.
   * @param {object} reservation
   * @param {{ amountMinor?: number, reason?: string, now?: Date }} [options]
   *   amountMinor: what the policy gives back; default and ceiling: the whole charge
   * @returns {Promise<{ attempt: object, created: boolean } | null>}
   */
  async function refundRelease(reservation, { amountMinor, now = new Date() } = {}) {
    if (!reservation || reservation.paymentStatus !== "simulated_paid") return null;
    const price = reservation.pricingSnapshot || {};
    const total = price.totalMinor;
    if (!Number.isSafeInteger(total) || total <= 0) return null;
    const amount = Number.isSafeInteger(amountMinor)
      ? Math.min(Math.max(amountMinor, 0), total)
      : total;
    if (amount === 0) return null;

    const key = `refund-${String(reservation._id)}`;
    const answered = await provider.refund({ amountMinor: amount, currency: price.currency });
    let attempt;
    let created = true;
    try {
      attempt = await AttemptModel.create({
        reservation: reservation._id,
        guest: reservation.guest,
        provider: provider.name || "simulated",
        kind: "refund",
        status: answered.status,
        amountMinor: amount,
        currency: price.currency,
        idempotencyKey: key,
        completedAt: now,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      created = false;
      attempt = await AttemptModel.findOne({ reservation: reservation._id, kind: "refund" });
    }
    await ReservationModel.updateOne(
      { _id: reservation._id, paymentStatus: "simulated_paid" },
      { $set: { paymentStatus: "refunded_simulated" } },
    );
    return { attempt, created };
  }

  return { pay, refundRelease };
}

module.exports = {
  ...createPaymentService(),
  createPaymentService,
  KEY_PATTERN,
  STALE_PENDING_MS,
};
