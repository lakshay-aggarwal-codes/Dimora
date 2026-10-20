// The only way to become an admin (P14-T01): scripts/make-admin.js calls this.
// No page, form or API sets `role`; signup and profile forms strip or refuse it.
const User = require("../models/user");
const audit = require("./audit");

class BootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = "BootstrapError";
  }
}

const ACTOR_LABEL = "cli:make-admin";

/**
 * Makes the active account with this email an admin and writes the audit row.
 * Running it again for an admin changes nothing and writes nothing.
 * Needs an open mongoose connection.
 * @returns {Promise<{changed: boolean, username: string}>}
 */
async function promoteToAdmin(email) {
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!User.EMAIL_PATTERN.test(address)) {
    throw new BootstrapError("Give the account's email address, e.g. you@example.com.");
  }

  const user = await User.findOne({ email: address });
  if (!user) throw new BootstrapError("No account has that email address.");
  if (user.status && user.status !== "active") {
    throw new BootstrapError(`That account is ${user.status}; only an active account can become an admin.`);
  }
  if (user.role === "admin") return { changed: false, username: user.username };

  const res = await User.updateOne(
    { _id: user._id, role: { $ne: "admin" }, status: { $in: ["active", null] } },
    { $set: { role: "admin" } },
  );
  if (res.modifiedCount !== 1) {
    // Changed by someone else between the read and the write.
    return { changed: false, username: user.username };
  }

  await audit.record({
    actorLabel: ACTOR_LABEL,
    action: "user.make_admin",
    targetType: "user",
    targetId: user._id,
    details: { username: user.username, previousRole: user.role || "member" },
  });
  return { changed: true, username: user.username };
}

module.exports = { promoteToAdmin, BootstrapError, ACTOR_LABEL };
