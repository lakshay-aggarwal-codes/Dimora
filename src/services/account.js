// Changing the password and deleting the account (P02-T04).
//
// Delete is an anonymisation, not a removal: bookings, reviews, messages and
// reports other people rely on stay, but they point to an account that no
// longer holds anything personal.
//
// What deletion refuses (each with its own message and code), so nobody is left
// waiting on a person who has gone:
//   guest_confirmed  a confirmed stay as guest that has not ended
//   guest_pending    a request as guest still waiting for the host
//   host_confirmed   a confirmed stay at one of the member's places that has not ended
//   host_pending     a request waiting for the member's answer
//   last_admin       the only active administrator
// Past stays and lapsed requests do not block.
//
// What it does, in order: unpublish the member's published listings (so no new
// request can arrive), look for blockers once more (a booking may have landed
// in between; if so the listings are published again and nothing else is
// changed), then anonymise the account in one update that only applies to a
// still-active account.
//
// Anonymised account: username `deleted-<id>`, display name "Deleted user",
// email replaced by an unusable `.invalid` address, bio and avatar removed,
// password hash and salt replaced by random unusable values, status `deleted`,
// verification cleared. Saved stays and notifications are deleted, and the
// label of reports about the account no longer carries the old name. Reviews,
// reservations, messages, reports made by the member and audit rows stay.
// Sessions on other devices stop working because they identify the member by
// the old username.
const crypto = require("node:crypto");
const { DEFAULT_TIMEZONE, todayIn } = require("../utils/dates");
const { AppError } = require("../utils/errors");

class AccountRefusal extends AppError {
  /** @param {string} message user-safe text @param {string} code */
  constructor(message, code, extra = {}) {
    super(409, message, { code });
    this.name = "AccountRefusal";
    Object.assign(this, extra);
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const idText = (v) => String(v && v._id ? v._id : v);

function models(over = {}) {
  return {
    UserModel: over.UserModel || require("../models/user"),
    ListingModel: over.ListingModel || require("../models/listing"),
    ReservationModel: over.ReservationModel || require("../models/reservation"),
    WishlistModel: over.WishlistModel || require("../models/wishlist"),
    WishlistItemModel:
      over.WishlistItemModel || require("../models/wishlistItem"),
    SavedSearchModel: over.SavedSearchModel || require("../models/savedSearch"),
    NotificationModel:
      over.NotificationModel || require("../models/notification"),
    ReportModel: over.ReportModel || require("../models/report"),
    deleteImage:
      over.deleteImage || require("../config/cloudinary").deleteImage,
  };
}

/**
 * The plugin's failed-login errors as refusals; null for anything else (a bug
 * or an outage), which must not be reported as "wrong password".
 */
function refusalForLoginError(error, wrongPasswordText) {
  const name = error && error.name;
  if (name === "AttemptTooSoonError" || name === "TooManyAttemptsError") {
    return new AccountRefusal(
      "Too many wrong passwords. Wait a few minutes and try again.",
      "locked",
    );
  }
  if (
    name === "IncorrectPasswordError" ||
    name === "MissingPasswordError" ||
    name === "IncorrectUsernameError" ||
    name === "NoSaltValueStoredError"
  ) {
    return new AccountRefusal(wrongPasswordText, "wrong_password");
  }
  return null;
}

/**
 * Everything that stops this member from deleting the account right now.
 * @returns {Promise<{code: string, message: string, count?: number}[]>} empty when deletion is allowed
 */
async function deletionBlockers(user, { now = new Date(), ...over } = {}) {
  const { ReservationModel, UserModel } = models(over);
  const today = todayIn(DEFAULT_TIMEZONE, now);
  const live = { $gt: now };
  const [guestConfirmed, guestPending, hostConfirmed, hostPending] =
    await Promise.all([
      ReservationModel.countDocuments({
        guest: user._id,
        status: "confirmed",
        checkOut: { $gt: today },
      }),
      ReservationModel.countDocuments({
        guest: user._id,
        status: "pending",
        holdExpiresAt: live,
      }),
      ReservationModel.countDocuments({
        host: user._id,
        status: "confirmed",
        checkOut: { $gt: today },
      }),
      ReservationModel.countDocuments({
        host: user._id,
        status: "pending",
        holdExpiresAt: live,
      }),
    ]);
  const blockers = [];
  if (guestConfirmed) {
    blockers.push({
      code: "guest_confirmed",
      count: guestConfirmed,
      message: `You have ${plural(guestConfirmed, "confirmed stay", "confirmed stays")} that ${guestConfirmed === 1 ? "has" : "have"} not ended. Cancel ${guestConfirmed === 1 ? "it" : "them"} or wait until the stay is over.`,
    });
  }
  if (guestPending) {
    blockers.push({
      code: "guest_pending",
      count: guestPending,
      message: `You have ${plural(guestPending, "booking request", "booking requests")} waiting for a host. Withdraw ${guestPending === 1 ? "it" : "them"} first.`,
    });
  }
  if (hostConfirmed) {
    blockers.push({
      code: "host_confirmed",
      count: hostConfirmed,
      message: `${plural(hostConfirmed, "guest has", "guests have")} a confirmed stay at one of your places that ${hostConfirmed === 1 ? "has" : "have"} not ended. Cancel ${hostConfirmed === 1 ? "it" : "them"} or wait until the stay is over.`,
    });
  }
  if (hostPending) {
    blockers.push({
      code: "host_pending",
      count: hostPending,
      message: `${plural(hostPending, "request is", "requests are")} waiting for your answer. Accept or decline ${hostPending === 1 ? "it" : "them"} first.`,
    });
  }
  if (user.role === "admin") {
    const others = await UserModel.countDocuments({
      role: "admin",
      status: "active",
      _id: { $ne: user._id },
    });
    if (others === 0) {
      blockers.push({
        code: "last_admin",
        message:
          "You are the only administrator. Make someone else an administrator before deleting this account.",
      });
    }
  }
  return blockers;
}

/** The fields an anonymised account has (the `$set`), and the ones it loses (the `$unset`). */
function anonymisedUpdate(id) {
  const text = idText(id);
  return {
    $set: {
      username: `deleted-${text}`,
      displayName: "Deleted user",
      email: `deleted-${text}@deleted.invalid`,
      bio: "",
      status: "deleted",
      emailVerifiedAt: null,
      // Unusable credentials: random values nobody knows, so no password matches.
      hash: crypto.randomBytes(32).toString("hex"),
      salt: crypto.randomBytes(32).toString("hex"),
      attempts: 0,
    },
    $unset: { avatar: "" },
  };
}

/**
 * Delete (anonymise) the account of `user` after checking their password.
 * @param {{ user: object, password: string, now?: Date }} input  `user` is a Mongoose document
 * @throws {AccountRefusal} 409 with `code` and, for blockers, `blockers`
 */
async function deleteAccount({ user, password, now = new Date(), ...over }) {
  const m = models(over);
  const { user: verified, error } = await user.authenticate(
    String(password ?? ""),
  );
  if (!verified) {
    throw (
      refusalForLoginError(error, "That password is not correct.") ||
      error ||
      new AccountRefusal("That password is not correct.", "wrong_password")
    );
  }

  const blockers = await deletionBlockers(user, { now, ...over });
  if (blockers.length > 0) {
    throw new AccountRefusal("Your account cannot be deleted yet.", "blocked", {
      blockers,
    });
  }

  const owned = await m.ListingModel.find({
    owner: user._id,
    status: "published",
    deletedAt: null,
  })
    .select("_id")
    .lean();
  const ids = owned.map((l) => l._id);
  const restore = () =>
    ids.length > 0
      ? m.ListingModel.updateMany(
          { _id: { $in: ids }, status: "unpublished" },
          { $set: { status: "published" } },
        )
      : null;
  if (ids.length > 0)
    await m.ListingModel.updateMany(
      { _id: { $in: ids }, status: "published" },
      { $set: { status: "unpublished" } },
    );

  try {
    // A request can have arrived between the first check and the unpublish.
    const late = await deletionBlockers(user, { now, ...over });
    if (late.length > 0) {
      await restore();
      throw new AccountRefusal(
        "Your account cannot be deleted yet.",
        "blocked",
        { blockers: late },
      );
    }
    const previousAvatar = user.avatar && user.avatar.filename;
    const done = await m.UserModel.findOneAndUpdate(
      { _id: user._id, status: "active" },
      anonymisedUpdate(user._id),
      { new: true },
    );
    if (!done) {
      await restore();
      throw new AccountRefusal(
        "This account was already changed. Reload the page.",
        "conflict",
      );
    }
    await Promise.all([
      m.WishlistItemModel.deleteMany({ owner: user._id }),
      m.WishlistModel.deleteMany({ owner: user._id }),
      m.SavedSearchModel.deleteMany({ owner: user._id }),
      m.NotificationModel.deleteMany({ user: user._id }),
      m.ReportModel.updateMany(
        { targetKind: "user", targetId: user._id },
        { $set: { targetLabel: "Deleted user" } },
      ),
    ]);
    if (previousAvatar)
      await Promise.resolve(m.deleteImage(previousAvatar)).catch(() => {}); // best effort: the account is already anonymised
    return { id: user._id, unpublished: ids.length };
  } catch (err) {
    if (!(err instanceof AccountRefusal))
      await Promise.resolve(restore()).catch(() => {});
    throw err;
  }
}

/**
 * Change the password after checking the current one (which also counts
 * towards the account's failed-attempt lock). The caller has already
 * validated the new password with `changePasswordSchema`.
 * @throws {AccountRefusal} wrong_password, locked
 */
async function changePassword({ user, currentPassword, newPassword }) {
  try {
    await user.changePassword(currentPassword, newPassword);
  } catch (err) {
    const refusal = refusalForLoginError(
      err,
      "Your current password is not correct.",
    );
    if (refusal) throw refusal;
    throw err;
  }
}

module.exports = {
  deletionBlockers,
  deleteAccount,
  changePassword,
  anonymisedUpdate,
  AccountRefusal,
};
