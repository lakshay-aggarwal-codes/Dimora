// One message (P11-T02): plain text, written only by
// src/services/conversations.js `send`, never edited or deleted.
const mongoose = require("mongoose");
const { LIMITS } = require("../config/conversations");

const Schema = mongoose.Schema;

const messageSchema = new Schema(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, maxlength: LIMITS.body },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ conversation: 1, _id: -1 });

module.exports = mongoose.model("Message", messageSchema);
