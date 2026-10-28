// Creating, checking and using the one-time email links (P02-T05).
//
//   issue    makes a token for (user, purpose), cancels the user's older unused
//            tokens of that purpose, and returns the raw token (the only time it
//            exists in clear). Throttled per account: one per minute, five per hour.
//   peek     "is this token usable?" without using it (the GET page, so a mail
//            scanner that opens the link cannot burn it).
//   consume  uses it, atomically: of two requests with the same token one wins.
const crypto = require("node:crypto");
const { AppError } = require("../utils/errors");

const VERIFY = "verify_email";
const RESET = "reset_password";
const TTL_MS = Object.freeze({
  [VERIFY]: 24 * 60 * 60 * 1000,
  [RESET]: 60 * 60 * 1000,
});
const MIN_GAP_MS = 60 * 1000;
const MAX_PER_HOUR = 5;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

class EmailThrottledError extends AppError {
  constructor(retryAfterSeconds) {
    super(429, `Please wait ${retryAfterSeconds} seconds before asking for another email.`, {
      code: "email_throttled",
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
const model = (over = {}) => over.EmailTokenModel || require("../models/emailToken");

async function issue({ user, purpose, now = new Date(), ...over }) {
  if (!TTL_MS[purpose]) throw new Error(`unknown token purpose "${purpose}"`);
  const Model = model(over);
  const recent = await Model.find({
    user: user._id,
    purpose,
    createdAt: { $gte: new Date(now.getTime() - 60 * 60 * 1000) },
  })
    .sort({ createdAt: -1 })
    .select("createdAt")
    .lean();

  if (recent.length > 0) {
    const sinceLast = now.getTime() - new Date(recent[0].createdAt).getTime();
    if (sinceLast < MIN_GAP_MS) throw new EmailThrottledError(Math.ceil((MIN_GAP_MS - sinceLast) / 1000));
  }
  if (recent.length >= MAX_PER_HOUR) {
    const oldest = new Date(recent[recent.length - 1].createdAt).getTime();
    throw new EmailThrottledError(Math.max(1, Math.ceil((oldest + 60 * 60 * 1000 - now.getTime()) / 1000)));
  }

  await Model.updateMany({ user: user._id, purpose, usedAt: null }, { $set: { usedAt: now } });
  const raw = crypto.randomBytes(32).toString("base64url");
  await Model.create({
    user: user._id,
    purpose,
    email: user.email,
    tokenHash: hashToken(raw),
    expiresAt: new Date(now.getTime() + TTL_MS[purpose]),
  });
  return raw;
}

function usable(raw, purpose, now) {
  if (typeof raw !== "string" || !TOKEN_PATTERN.test(raw)) return null;
  return { tokenHash: hashToken(raw), purpose, usedAt: null, expiresAt: { $gt: now } };
}

/** The token row if the token can still be used; nothing is changed. */
async function peek({ raw, purpose, now = new Date(), ...over }) {
  const filter = usable(raw, purpose, now);
  return filter ? model(over).findOne(filter).lean() : null;
}

/** Uses the token (once). Returns the row, or null if it is unknown, used or expired. */
async function consume({ raw, purpose, now = new Date(), ...over }) {
  const filter = usable(raw, purpose, now);
  return filter ? model(over).findOneAndUpdate(filter, { $set: { usedAt: now } }, { new: true }).lean() : null;
}

/** Cancels every unused token of a purpose (after a password reset). */
async function revokeAll({ userId, purpose, now = new Date(), ...over }) {
  await model(over).updateMany({ user: userId, purpose, usedAt: null }, { $set: { usedAt: now } });
}

module.exports = {
  VERIFY,
  RESET,
  TTL_MS,
  MIN_GAP_MS,
  MAX_PER_HOUR,
  TOKEN_PATTERN,
  EmailThrottledError,
  hashToken,
  issue,
  peek,
  consume,
  revokeAll,
};
