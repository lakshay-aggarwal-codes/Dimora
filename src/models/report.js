// A report about a listing, review, member or message (P12-T04). Created only
// through src/services/reports.js. Never deleted: moderators (P14-T04) close
// it as resolved or dismissed.
//
// One OPEN report per (reporter, target): the partial unique index below is
// what makes that true under concurrent requests; the service only turns the
// index error into a friendly message. Once a report is closed the same
// person may report the same target again.
const mongoose = require("mongoose");
const {
  KIND_VALUES,
  REASON_VALUES,
  REPORT_STATUSES,
  LIMITS,
} = require("../config/reports");
const Schema = mongoose.Schema;

const reportSchema = new Schema(
  {
    reporter: { type: Schema.Types.ObjectId, ref: "User", required: true },
    targetKind: { type: String, enum: KIND_VALUES, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    // Who made the thing that was reported (listing host, review author, the
    // member). null when unknown (an old review without an author).
    targetOwner: { type: Schema.Types.ObjectId, ref: "User", default: null },
    // Short text so the reporter's list still reads when the target changes or goes.
    targetLabel: { type: String, trim: true, maxlength: 160 },

    reason: { type: String, enum: REASON_VALUES, required: true },
    details: { type: String, trim: true, maxlength: LIMITS.detailsMax },

    status: {
      type: String,
      enum: REPORT_STATUSES,
      default: "open",
      required: true,
    },
    // Filled when a moderator closes it (P14-T04).
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    resolutionNote: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

reportSchema.index(
  { reporter: 1, targetKind: 1, targetId: 1 },
  { unique: true, partialFilterExpression: { status: "open" } },
);
reportSchema.index({ reporter: 1, createdAt: -1 });
reportSchema.index({ status: 1, createdAt: -1 }); // the moderators' queue
reportSchema.index({ targetKind: 1, targetId: 1 });

module.exports = mongoose.model("Report", reportSchema);
