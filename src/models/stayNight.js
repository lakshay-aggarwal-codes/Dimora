// Night ledger (ADR-004, P07-T02). One document per occupied night of a
// listing: a reserved night (source.kind "reservation") or a host block
// ("block"). The unique index on (listing, date) is what makes double booking
// impossible: the database, not application code, refuses a second owner.
//
// `date` is a calendar date stored at 00:00:00.000Z (ADR-003). The check-out
// day of a stay is NOT a night. `holdExpiresAt` is set only while a pending
// (host-approval) request holds the night; a confirmed reservation or a block
// has none. Rows are written and removed only through src/services/ledger.js.
const mongoose = require("mongoose");
const { isDateOnly } = require("../utils/dates");
const Schema = mongoose.Schema;

const SOURCE_KINDS = Object.freeze(["reservation", "block"]);

const stayNightSchema = new Schema(
  {
    listing: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      required: true,
    },
    date: {
      type: Date,
      required: true,
      validate: {
        validator: isDateOnly,
        message: "date must be a date-only value (00:00:00.000Z)",
      },
    },
    source: {
      kind: { type: String, enum: SOURCE_KINDS, required: true },
      id: { type: Schema.Types.ObjectId, required: true },
    },
    holdExpiresAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// The guard: no two rows for the same listing and night.
stayNightSchema.index({ listing: 1, date: 1 }, { unique: true });
// Release everything held by one reservation or block.
stayNightSchema.index({ "source.id": 1 });
// The sweeper finds expired holds (rows without a hold are skipped).
stayNightSchema.index({ holdExpiresAt: 1 }, { sparse: true });

const StayNight = mongoose.model("StayNight", stayNightSchema);
StayNight.SOURCE_KINDS = SOURCE_KINDS;

module.exports = StayNight;
