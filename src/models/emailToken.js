// One-time links sent by email (P02-T05): "confirm your address" and "reset your
// password". Only a SHA-256 hash of the token is stored, so a copy of the
// database cannot be used to take over an account. A token works once (`usedAt`)
// and only until `expiresAt`; the TTL index removes rows a week after that.
const mongoose = require("mongoose");

const PURPOSES = ["verify_email", "reset_password"];
const KEEP_AFTER_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

const emailTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    purpose: { type: String, enum: PURPOSES, required: true },
    // The address the link was sent to. A link for an address the account no
    // longer has confirms nothing.
    email: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: KEEP_AFTER_EXPIRY_SECONDS });
emailTokenSchema.index({ user: 1, purpose: 1, createdAt: -1 });

const EmailToken = mongoose.model("EmailToken", emailTokenSchema);

module.exports = EmailToken;
module.exports.PURPOSES = PURPOSES;
