// Who may do what with a listing. `(user, listing) => boolean`.
// `user` is req.user (or undefined for an anonymous visitor).
const { sameId, isActiveUser, isAdmin } = require("./shared");

/** Any active member can create a listing. */
function create(user) {
  return isActiveUser(user);
}

/** Only the host edits a listing (an admin moderates; see `remove`). */
function edit(user, listing) {
  return Boolean(
    isActiveUser(user) && listing && sameId(listing.owner, user._id),
  );
}

/** The host, or an admin. A listing without an owner can only be removed by an admin. */
function remove(user, listing) {
  return Boolean(listing) && (edit(user, listing) || isAdmin(user));
}

module.exports = { create, edit, delete: remove };
