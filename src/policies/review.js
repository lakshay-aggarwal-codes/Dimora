// Who may do what with a review. `(user, review) => boolean`.
const { sameId, isActiveUser, isAdmin } = require("./shared");

/** Any active member can write a review (eligibility rules arrive in P12-T01). */
function create(user) {
  return isActiveUser(user);
}

/** The author, or an admin. A review without an author can only be removed by an admin. */
function remove(user, review) {
  if (!review) return false;
  return Boolean(
    (isActiveUser(user) && sameId(review.author, user._id)) || isAdmin(user),
  );
}

/**
 * Only the author edits a review, and only while the account is active. An
 * admin moderates (hides) but never rewrites someone's words. Whether the edit
 * window is still open is decided by services/reviews.js, which knows the time.
 */
function edit(user, review) {
  return Boolean(
    review && isActiveUser(user) && sameId(review.author, user._id),
  );
}

/**
 * The host's reply (P12-T03). The resource is the LISTING the review is on:
 * only its owner may reply, edit the reply or take it back.
 */
function reply(user, listing) {
  return Boolean(
    listing && isActiveUser(user) && sameId(listing.owner, user._id),
  );
}

module.exports = { create, delete: remove, edit, reply };
