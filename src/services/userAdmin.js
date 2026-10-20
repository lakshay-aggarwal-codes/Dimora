// User management for admins (P14-T02): search, activity summary, suspend and
// reinstate. The routes (src/routes/admin.js) call these inside
// auditedMutation, which writes the audit row; nothing here writes one.
//
// Suspending an account:
//   1. sets status "suspended" (atomically, only from "active");
//   2. hides its published listings (status "suspended", flagged so that
//      reinstating restores exactly those);
//   3. deletes the account's sessions from the session store;
//   4. reports how many pending / confirmed reservations there are to handle.
//      Reservations do not exist yet (P07-T05), so that count is 0 for now.
// Reinstating reverses 1 and 2.
const mongoose = require("mongoose");
const User = require("../models/user");
const Listing = require("../models/listing");
const Review = require("../models/review");
const AuditLog = require("../models/auditLog");
const { toPageNumber } = require("./audit");

const PAGE_SIZE = 20;
const REASON_MIN = 5;
const REASON_MAX = 500;
const QUERY_MAX = 100;
const LIST_FIELDS = "username email displayName role status createdAt";

class UserAdminError extends Error {
  /** @param {string} message user-safe text, shown to the admin */
  constructor(message) {
    super(message);
    this.name = "UserAdminError";
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isId(value) {
  return typeof value === "string" && mongoose.isValidObjectId(value);
}

/** The trimmed reason, or a UserAdminError when it is missing/too short/long. */
function cleanReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < REASON_MIN) {
    throw new UserAdminError(
      `Give a reason (at least ${REASON_MIN} characters). It is written to the audit log.`,
    );
  }
  if (reason.length > REASON_MAX) {
    throw new UserAdminError(`The reason must be ${REASON_MAX} characters or fewer.`);
  }
  return reason;
}

/**
 * Users matching a text (username, email or display name; case-insensitive,
 * matched as plain text, never as a pattern), optionally one status.
 * @returns {{rows: object[], page: number, totalPages: number, total: number, q: string, status: string}}
 */
async function searchUsers({ q, status, page } = {}) {
  const text = typeof q === "string" ? q.trim().slice(0, QUERY_MAX) : "";
  const filter = {};
  if (text) {
    const rx = new RegExp(escapeRegex(text), "i");
    filter.$or = [{ username: rx }, { email: rx }, { displayName: rx }];
  }
  const wanted = typeof status === "string" && User.STATUSES.includes(status) ? status : "";
  if (wanted) filter.status = wanted;

  const total = await User.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(toPageNumber(page), totalPages);
  const rows = await User.find(filter)
    .select(LIST_FIELDS)
    .sort({ username: 1, _id: 1 })
    .skip((current - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();
  return { rows, page: current, totalPages, total, q: text, status: wanted };
}

/**
 * One account with a small activity summary, or null for a malformed or
 * unknown id. Never includes the password hash or salt.
 */
async function getUserSummary(id) {
  if (!isId(id)) return null;
  const user = await User.findById(id).select(LIST_FIELDS).lean();
  if (!user) return null;

  const [byStatus, reviewsWritten, history] = await Promise.all([
    Listing.aggregate([
      { $match: { owner: user._id, deletedAt: null } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Review.countDocuments({ author: user._id }),
    AuditLog.find({ targetType: "user", targetId: user._id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(10)
      .populate("actor", "username")
      .lean(),
  ]);

  const listings = { draft: 0, published: 0, unpublished: 0, suspended: 0, total: 0 };
  for (const row of byStatus) {
    if (row._id in listings) listings[row._id] = row.count;
    listings.total += row.count;
  }
  return {
    user,
    activity: { listings, reviewsWritten },
    // Reservations arrive with P07-T05.
    reservations: { pending: 0, confirmed: 0 },
    history,
  };
}

/**
 * Deletes every session that belongs to `username` from the session store.
 * - connect-mongo: one deleteMany on the sessions collection (the session is
 *   stored as JSON text, so the passport user is matched in that text).
 * - express-session MemoryStore (tests, local use): walks all().
 * A store that supports neither is reported, never silently skipped.
 * @returns {Promise<number>} sessions deleted (-1 when the store reports no count)
 */
async function destroyUserSessions(store, username) {
  if (!store) throw new Error("destroyUserSessions: no session store");

  if (store.collectionP && typeof store.collectionP.then === "function") {
    const collection = await store.collectionP;
    const needle = `"passport":{"user":${JSON.stringify(username)}`;
    const result = await collection.deleteMany({
      session: { $regex: escapeRegex(needle) },
    });
    return typeof result.deletedCount === "number" ? result.deletedCount : -1;
  }

  if (typeof store.all === "function" && typeof store.destroy === "function") {
    const sessions = await new Promise((resolve, reject) =>
      store.all((err, all) => (err ? reject(err) : resolve(all))),
    );
    if (sessions && !Array.isArray(sessions)) {
      let deleted = 0;
      for (const [sid, sess] of Object.entries(sessions)) {
        if (sess && sess.passport && sess.passport.user === username) {
          await new Promise((resolve, reject) =>
            store.destroy(sid, (err) => (err ? reject(err) : resolve())),
          );
          deleted += 1;
        }
      }
      return deleted;
    }
  }

  throw new Error("destroyUserSessions: this session store cannot delete by user");
}

/**
 * @param {object} args
 * @param {object} args.admin the acting admin (req.user)
 * @param {string} args.id target user id
 * @param {string} args.reason required text
 * @param {object} args.store session store (req.sessionStore)
 * @returns {Promise<{user: object, details: object, reason: string}>}
 * @throws {UserAdminError} nothing was changed
 */
async function suspendUser({ admin, id, reason, store }) {
  const text = cleanReason(reason);
  if (!isId(id)) throw new UserAdminError("That account does not exist.");
  const target = await User.findById(id).select("username role status");
  if (!target) throw new UserAdminError("That account does not exist.");

  if (String(target._id) === String(admin._id)) {
    throw new UserAdminError("You cannot suspend your own account.");
  }
  if (target.status !== "active") {
    throw new UserAdminError(`That account is already ${target.status}.`);
  }
  if (target.role === "admin") {
    const admins = await User.countDocuments({ role: "admin", status: { $in: ["active", null] } });
    if (admins <= 1) throw new UserAdminError("You cannot suspend the last admin.");
  }

  // Only an active account can become suspended; two admins acting at once
  // cannot both succeed.
  const res = await User.updateOne(
    { _id: target._id, status: "active" },
    { $set: { status: "suspended" } },
  );
  if (res.modifiedCount !== 1) {
    throw new UserAdminError("That account changed while you were working. Reload and try again.");
  }

  const hidden = await Listing.updateMany(
    { owner: target._id, status: "published", deletedAt: null },
    { $set: { status: "suspended", hiddenByOwnerSuspension: true } },
  );
  const sessions = await destroyUserSessions(store, target.username);

  return {
    user: target,
    reason: text,
    details: {
      username: target.username,
      role: target.role,
      from: "active",
      to: "suspended",
      listingsHidden: hidden.modifiedCount,
      sessionsDeleted: sessions,
      // Reservations: none exist yet (P07-T05). When they do, pending ones are
      // declined here and confirmed ones are counted for admin handling.
      reservationsPendingDeclined: 0,
      reservationsConfirmedFlagged: 0,
    },
  };
}

/** Reverses suspendUser. A deleted account cannot be reinstated. */
async function reinstateUser({ id, reason }) {
  const text = cleanReason(reason);
  if (!isId(id)) throw new UserAdminError("That account does not exist.");
  const target = await User.findById(id).select("username role status");
  if (!target) throw new UserAdminError("That account does not exist.");
  if (target.status !== "suspended") {
    throw new UserAdminError("Only a suspended account can be reinstated.");
  }

  const res = await User.updateOne(
    { _id: target._id, status: "suspended" },
    { $set: { status: "active" } },
  );
  if (res.modifiedCount !== 1) {
    throw new UserAdminError("That account changed while you were working. Reload and try again.");
  }
  const restored = await Listing.updateMany(
    { owner: target._id, status: "suspended", hiddenByOwnerSuspension: true, deletedAt: null },
    { $set: { status: "published" }, $unset: { hiddenByOwnerSuspension: "" } },
  );

  return {
    user: target,
    reason: text,
    details: {
      username: target.username,
      from: "suspended",
      to: "active",
      listingsRestored: restored.modifiedCount,
    },
  };
}

module.exports = {
  searchUsers,
  getUserSummary,
  suspendUser,
  reinstateUser,
  destroyUserSessions,
  cleanReason,
  UserAdminError,
  PAGE_SIZE,
  REASON_MIN,
  REASON_MAX,
};
