// A booking (P07-T05). Created only through src/services/reservations.js,
// which holds the nights in the ledger first (ADR-004). Never hard-deleted.
//
// The snapshots keep the guest's contract correct when the listing changes
// later: the price breakdown, and the title, rules and policy as they were.
const mongoose = require("mongoose");
const { isDateOnly } = require("../utils/dates");
const { STATUSES, ACTORS } = require("../services/stateMachine");
const Schema = mongoose.Schema;

const dateOnly = {
  type: Date,
  required: true,
  validate: {
    validator: isDateOnly,
    message: "{PATH} must be a date-only value (00:00:00.000Z)",
  },
};
const minor = { type: Number, min: 0, validate: Number.isSafeInteger };

const historySchema = new Schema(
  {
    from: { type: String, enum: [...STATUSES, null], default: null },
    to: { type: String, enum: STATUSES, required: true },
    at: { type: Date, required: true },
    actor: { type: String, enum: ACTORS, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User" },
    note: { type: String, maxlength: 500 },
  },
  { _id: false },
);

const reservationSchema = new Schema(
  {
    listing: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    guest: { type: Schema.Types.ObjectId, ref: "User", required: true },
    host: { type: Schema.Types.ObjectId, ref: "User", required: true },

    checkIn: dateOnly,
    checkOut: dateOnly,
    nights: { type: Number, required: true, min: 1, max: 90, validate: Number.isInteger },
    guests: { type: Number, required: true, min: 1, max: 100, validate: Number.isInteger },

    status: { type: String, enum: STATUSES, required: true },
    statusHistory: { type: [historySchema], default: [] },
    // Set only while a host-approval request is pending (the ledger rows carry
    // the same instant).
    holdExpiresAt: { type: Date },

    pricingSnapshot: {
      lines: { type: [Schema.Types.Mixed], default: [] },
      nights: minor,
      subtotalMinor: minor,
      cleaningMinor: minor,
      serviceFeeMinor: minor,
      taxMinor: minor,
      totalMinor: { ...minor, required: true },
      avgPerNightMinor: minor,
      currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
      taxMode: { type: String },
      taxIncluded: { type: Boolean },
      breakdownVersion: { type: Number },
    },

    listingSnapshot: {
      title: { type: String },
      city: { type: String },
      coverUrl: { type: String },
      houseRules: { type: String },
      noSpecialRules: { type: Boolean },
      cancellationPolicy: { type: String },
      checkInTime: { type: String },
      checkOutTime: { type: String },
      timezone: { type: String },
      instantBook: { type: Boolean },
    },

    // Chosen by the browser per checkout page; a repeated submit returns the
    // original reservation (unique with the guest).
    idempotencyKey: { type: String, required: true, minlength: 8, maxlength: 64 },

    cancelReason: { type: String, trim: true, maxlength: 500 },
    cancelledBy: { type: String, enum: ACTORS },
    // What a cancellation refunds (P09-T03), written in the same update that
    // changes the status. CALCULATED AND RECORDED only: no money moves
    // (payments are simulated until P16, which acts on this record).
    refund: {
      amountMinor: minor,
      retainedMinor: minor,
      totalMinor: minor,
      currency: { type: String, match: /^[A-Z]{3}$/ },
      policy: { type: String },
      rule: { type: String },
      calculatedAt: { type: Date },
    },
    paymentStatus: {
      type: String,
      enum: ["none", "simulated_paid", "refunded_simulated"],
      default: "none",
    },
  },
  { timestamps: true },
);

reservationSchema.pre("validate", function () {
  if (this.checkIn && this.checkOut && this.checkOut <= this.checkIn) {
    this.invalidate("checkOut", "Check-out must be after check-in.");
  }
});

reservationSchema.index({ guest: 1, createdAt: -1 });
reservationSchema.index({ host: 1, status: 1 });
reservationSchema.index({ listing: 1, checkIn: 1 });
reservationSchema.index({ guest: 1, idempotencyKey: 1 }, { unique: true });
// The sweeper (P07-T07) looks for requests past their hold and for stays whose
// check-out has passed.
reservationSchema.index({ status: 1, holdExpiresAt: 1 });
reservationSchema.index({ status: 1, checkOut: 1 });

module.exports = mongoose.model("Reservation", reservationSchema);
