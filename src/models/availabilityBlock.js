// A host's "I am not available" record (P07-T03). One document per block the
// host created: the date range as asked and an optional private note.
//
// The nights themselves live in the night ledger (src/models/stayNight.js)
// with source { kind: "block", id: <this _id> }; the ledger, not this record,
// decides what is blocked. After a partial unblock the record may therefore
// describe more nights than are still blocked; the calendar always reads the
// ledger. A block with no night left is deleted.
//
// `from` is the first blocked night and `to` the day after the last one (the
// same half-open range as a stay: ADR-003). Both are date-only (00:00:00Z).
const mongoose = require("mongoose");
const { isDateOnly } = require("../utils/dates");
const Schema = mongoose.Schema;

const NOTE_MAX_LENGTH = 200;

const dateOnly = {
  type: Date,
  required: true,
  validate: {
    validator: isDateOnly,
    message: "must be a date-only value (00:00:00.000Z)",
  },
};

const availabilityBlockSchema = new Schema(
  {
    listing: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    from: dateOnly,
    to: dateOnly,
    note: { type: String, trim: true, maxlength: NOTE_MAX_LENGTH, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

availabilityBlockSchema.index({ listing: 1, from: 1 });

const AvailabilityBlock = mongoose.model(
  "AvailabilityBlock",
  availabilityBlockSchema,
);
AvailabilityBlock.NOTE_MAX_LENGTH = NOTE_MAX_LENGTH;

module.exports = AvailabilityBlock;
