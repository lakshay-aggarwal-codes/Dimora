// One simulated payment step of one booking (P16-T01, ADR-009).
//
// A "charge" is the guest pressing "Pay (simulated)"; a "refund" is the record
// that a paid booking ended without a stay. NOTHING here moves money, and NO
// card data exists anywhere: the schema has no field for a number, an expiry
// or a CVV (and is strict, so a stray field is dropped).
//
// Three unique indexes make the rules the database's, not the code's:
//   - (reservation, idempotencyKey)   one attempt per button page; a double
//                                     click that sends the same key cannot
//                                     make a second attempt
//   - (reservation) where live        at most ONE charge that is pending or
//                                     succeeded; a failed charge stops being
//                                     live so the guest may try again
//   - (reservation) where kind refund one refund per booking
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const KINDS = Object.freeze(["charge", "refund"]);
const STATUSES = Object.freeze(["pending", "succeeded", "failed", "refunded_simulated"]);
const PROVIDERS = Object.freeze(["simulated"]);

const minor = { type: Number, min: 0, validate: Number.isSafeInteger };

const paymentAttemptSchema = new Schema(
  {
    reservation: { type: Schema.Types.ObjectId, ref: "Reservation", required: true },
    guest: { type: Schema.Types.ObjectId, ref: "User", required: true },
    provider: { type: String, enum: PROVIDERS, default: "simulated", required: true },
    kind: { type: String, enum: KINDS, required: true },
    status: { type: String, enum: STATUSES, required: true },
    amountMinor: { ...minor, required: true },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    idempotencyKey: { type: String, required: true, minlength: 8, maxlength: 64 },
    // The outcome the simulation was asked for (success, declined, error) and
    // why a charge failed. Plain codes, never free text from the browser.
    requestedOutcome: { type: String, enum: ["success", "declined", "error"] },
    failureCode: { type: String, maxlength: 40 },
    // true while a charge is pending or succeeded (see the index above).
    live: { type: Boolean, default: false },
    completedAt: { type: Date },
  },
  { timestamps: true, strict: true },
);

paymentAttemptSchema.index({ reservation: 1, idempotencyKey: 1 }, { unique: true });
paymentAttemptSchema.index(
  { reservation: 1 },
  { unique: true, partialFilterExpression: { live: true }, name: "one_live_charge_per_reservation" },
);
paymentAttemptSchema.index(
  { reservation: 1 },
  { unique: true, partialFilterExpression: { kind: "refund" }, name: "one_refund_per_reservation" },
);
paymentAttemptSchema.index({ guest: 1, createdAt: -1 });

const PaymentAttempt = mongoose.model("PaymentAttempt", paymentAttemptSchema);
PaymentAttempt.KINDS = KINDS;
PaymentAttempt.STATUSES = STATUSES;

module.exports = PaymentAttempt;
