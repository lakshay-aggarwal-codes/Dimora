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

module.exports = { create, delete: remove };
