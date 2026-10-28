// Confirming an email address and resetting a password (P02-T05).
//
// Rules:
//   - A confirmation link proves the person can read mail sent to the address
//     the account had WHEN THE LINK WAS SENT; if the address changed since, it
//     confirms nothing.
//   - "Forgot password" never says whether the address belongs to an account:
//     the caller always shows the same answer. Suspended and deleted accounts get
//     no email.
//   - A reset link works once and for one hour. Using it sets the new password,
//     clears the failed-login lock, cancels other reset links, confirms the
//     address (the link proved it), and sends a "your password was changed" note.
const tokens = require("./emailTokens");
const templates = require("../emails/templates");

const models = (over = {}) => ({ UserModel: over.UserModel || require("../models/user") });
const link = (baseUrl, path, raw) => `${String(baseUrl).replace(/\/+$/, "")}${path}${raw}`;
const hours = (ms) => Math.round(ms / 3600000);

/** Sends the "confirm your address" email. Throws EmailThrottledError / EmailError. */
async function sendVerification({ user, emailService, baseUrl, now = new Date(), ...over }) {
  if (user.emailVerifiedAt) return { status: "already_verified" };
  const raw = await tokens.issue({ user, purpose: tokens.VERIFY, now, ...over });
  await emailService.send({
    to: user.email,
    ...templates.verifyEmail({
      name: user.displayName || user.username,
      link: link(baseUrl, "/verify-email/", raw),
      hours: hours(tokens.TTL_MS[tokens.VERIFY]),
    }),
  });
  return { status: "sent" };
}

/** Uses a confirmation token. { ok: true, user } or { ok: false }. */
async function verifyEmail({ raw, now = new Date(), ...over }) {
  const { UserModel } = models(over);
  const token = await tokens.consume({ raw, purpose: tokens.VERIFY, now, ...over });
  if (!token) return { ok: false };
  const user = await UserModel.findOneAndUpdate(
    { _id: token.user, email: token.email, status: "active" },
    { $set: { emailVerifiedAt: now } },
    { new: true },
  );
  return user ? { ok: true, user } : { ok: false };
}

/**
 * Sends a reset link if an active account has this address. Returns nothing the
 * caller could show: the answer to the visitor is the same either way.
 */
async function requestPasswordReset({ email, emailService, baseUrl, now = new Date(), ...over }) {
  const { UserModel } = models(over);
  const user = await UserModel.findOne({ email: String(email).trim().toLowerCase(), status: "active" });
  if (!user) return { sent: false };
  const raw = await tokens.issue({ user, purpose: tokens.RESET, now, ...over });
  await emailService.send({
    to: user.email,
    ...templates.resetPassword({
      name: user.displayName || user.username,
      link: link(baseUrl, "/reset-password/", raw),
      minutes: Math.round(tokens.TTL_MS[tokens.RESET] / 60000),
    }),
  });
  return { sent: true };
}

/** The active account a still-usable reset token belongs to, or null. Uses nothing. */
async function userForResetToken({ raw, now = new Date(), ...over }) {
  const { UserModel } = models(over);
  const token = await tokens.peek({ raw, purpose: tokens.RESET, now, ...over });
  if (!token) return null;
  return UserModel.findOne({ _id: token.user, email: token.email, status: "active" });
}

/**
 * Sets a new password with a reset token. The password must already have been
 * checked against the rules (validation/resetPasswordSchema).
 * @returns {{ ok: boolean, user?: object }}
 */
async function resetPassword({ raw, newPassword, emailService, now = new Date(), ...over }) {
  const { UserModel } = models(over);
  const token = await tokens.consume({ raw, purpose: tokens.RESET, now, ...over });
  if (!token) return { ok: false };
  const user = await UserModel.findOne({ _id: token.user, email: token.email, status: "active" });
  if (!user) return { ok: false };

  await user.setPassword(newPassword);
  user.attempts = 0; // lift the failed-login lock (P02-T02)
  if (!user.emailVerifiedAt) user.emailVerifiedAt = now; // the link was read at this address
  await user.save();
  await tokens.revokeAll({ userId: user._id, purpose: tokens.RESET, now, ...over });

  if (emailService) {
    try {
      await emailService.send({
        to: user.email,
        ...templates.passwordChanged({ name: user.displayName || user.username }),
      });
    } catch {
      // The password is already changed; the note is a courtesy.
    }
  }
  return { ok: true, user };
}

module.exports = {
  sendVerification,
  verifyEmail,
  requestPasswordReset,
  userForResetToken,
  resetPassword,
};
