// A conversation between one guest and one host (P11-T02). Two kinds:
//   - general: about a listing, started with "Contact host"
//     (threadKey `listing:<listingId>:<guestId>`), and
//   - reservation-bound: about one booking, opened by either side
//     (threadKey `reservation:<reservationId>`).
// The unique index on `threadKey` makes both idempotent: starting twice (or two
// clicks at once) gives the same conversation. Created and changed only by
// src/services/conversations.js.
const mongoose = require("mongoose");
const { LIMITS } = require("../config/conversations");

const Schema = mongoose.Schema;

const conversationSchema = new Schema(
  {
    threadKey: { type: String, required: true, maxlength: 80 },
    listing: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    guest: { type: Schema.Types.ObjectId, ref: "User", required: true },
    host: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reservation: { type: Schema.Types.ObjectId, ref: "Reservation", default: null },

    // Messages this side has not read yet (one counter per side).
    unread: {
      guest: { type: Number, default: 0, min: 0 },
      host: { type: Number, default: 0, min: 0 },
    },
    // null until the first message: such a thread is not listed.
    lastMessageAt: { type: Date, default: null },
    lastMessage: {
      sender: { type: Schema.Types.ObjectId, ref: "User" },
      preview: { type: String, maxlength: LIMITS.preview },
    },
  },
  { timestamps: true },
);

conversationSchema.index({ threadKey: 1 }, { unique: true });
// "My conversations", newest message first, for either side.
conversationSchema.index({ guest: 1, lastMessageAt: -1 });
conversationSchema.index({ host: 1, lastMessageAt: -1 });

module.exports = mongoose.model("Conversation", conversationSchema);
