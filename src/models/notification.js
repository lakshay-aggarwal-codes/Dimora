// In-app notification (P11-T01): one row per message to one member. Written
// only through src/services/notifications.js `notify`, which validates the
// text and the link; read only for the member it belongs to (every query in
// the service filters on `user`).
//
// Lifecycle: created unread (`readAt: null`, no `deleteAfter`). Reading sets
// `readAt` and `deleteAfter` (read time + READ_RETENTION_DAYS); the TTL index
// on `deleteAfter` then removes the row. MongoDB ignores a row whose
// `deleteAfter` is not a date, so unread rows are never removed by it.
const mongoose = require("mongoose");
const {
  REF_KINDS,
  TYPE_PATTERN,
  LIMITS,
} = require("../config/notifications");

const Schema = mongoose.Schema;

const notificationSchema = new Schema(
  {
    // The only person who can see this row.
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
      match: TYPE_PATTERN,
      maxlength: LIMITS.type,
    },
    // What the message is about (a booking, a listing...), if anything.
    ref: {
      kind: { type: String, enum: REF_KINDS },
      id: { type: Schema.Types.ObjectId },
    },
    // Plain text; views escape it. `url` is a same-site path.
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.title,
    },
    body: { type: String, trim: true, maxlength: LIMITS.body },
    url: { type: String, trim: true, maxlength: LIMITS.url },
    readAt: { type: Date, default: null },
    deleteAfter: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The list (newest first, optionally unread only) and the unread count.
notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });
// TTL: removes a read notification once `deleteAfter` has passed.
notificationSchema.index({ deleteAfter: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Notification", notificationSchema);
