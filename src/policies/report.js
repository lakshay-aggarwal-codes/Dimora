// Who may report what (P12-T04). `(user, target) => boolean`, where target is
// `{ owner }`: whoever made the thing being reported.
const { sameId, isActiveUser } = require("./shared");

/** Any active member, except about their own listing, review or profile. */
function create(user, target) {
  if (!isActiveUser(user)) return false;
  return !(target && sameId(target.owner, user._id));
}

module.exports = { create };
