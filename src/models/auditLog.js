// Audit log (P14-T01): one row per administrative action, written by
// src/services/audit.js in the same request as the action itself.
//
// Append-only by design: a row is created once and never changed. Saving an
// existing row, every update/replace/delete query and bulkWrite with anything
// but inserts are refused here, and the admin area has no route that edits or
// removes rows (the viewer is read-only). A direct driver call
// (`Model.collection`) or a database shell is outside what the model can
// stop; restrict database credentials for that.
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TARGET_TYPES = Object.freeze([
  "user",
  "listing",
  "review",
  "report",
  "reservation",
  "system",
]);

const auditLogSchema = new Schema(
  {
    // The admin who acted. null for an action taken outside a login
    // (`scripts/make-admin.js`); `actorLabel` then says who/what did it.
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorLabel: { type: String, trim: true, maxlength: 120 },

    // Stable machine name, e.g. "user.make_admin", "user.suspend".
    action: {
      type: String,
      required: true,
      trim: true,
      match: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
      maxlength: 80,
    },
    targetType: { type: String, enum: TARGET_TYPES, required: true },
    targetId: { type: Schema.Types.ObjectId, default: null },

    // Required free text for actions that need a reason (suspensions...).
    reason: { type: String, trim: true, maxlength: 1000 },

    // Small, non-secret facts about the change (old/new status...). Never
    // passwords, tokens or whole documents.
    details: { type: Schema.Types.Mixed },

    requestId: { type: String, maxlength: 80 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

const REFUSED = "Audit log entries cannot be changed or deleted.";

auditLogSchema.pre("save", function () {
  if (!this.isNew) throw new Error(REFUSED);
});

auditLogSchema.pre(
  [
    "updateOne",
    "updateMany",
    "replaceOne",
    "findOneAndUpdate",
    "findOneAndReplace",
    "findOneAndDelete",
    "deleteOne",
    "deleteMany",
  ],
  { document: false, query: true },
  function () {
    throw new Error(REFUSED);
  },
);

auditLogSchema.pre(
  ["deleteOne", "updateOne"],
  { document: true, query: false },
  function () {
    throw new Error(REFUSED);
  },
);

// Only inserts may go through bulkWrite (Mongoose 9 passes the operations as
// the first argument; throwing refuses the call).
auditLogSchema.pre("bulkWrite", function (ops) {
  const onlyInserts =
    Array.isArray(ops) && ops.every((op) => op && op.insertOne);
  if (!onlyInserts) throw new Error(REFUSED);
});

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
module.exports.TARGET_TYPES = TARGET_TYPES;
module.exports.REFUSED_MESSAGE = REFUSED;
