// Small helpers shared by the policy files. Pure: no database, no Express.

/** Id of an ObjectId, a populated document, a plain { _id } or a string. */
function idOf(value) {
  if (value === undefined || value === null) return null;
  if (value._id !== undefined && value._id !== null) return String(value._id);
  // A bare ObjectId (some driver versions have no `_id` getter) or a string.
  if (typeof value !== "object" || typeof value.toHexString === "function") {
    return String(value);
  }
  return null; // an object that carries no id

}

/** True when both refer to the same id. A missing id never matches. */
function sameId(a, b) {
  const x = idOf(a);
  const y = idOf(b);
  return x !== null && y !== null && x === y;
}

/**
 * A logged-in account that may act. Accounts created before the v2 user model
 * have no `status`; they count as active. Suspended/deleted accounts can do
 * nothing.
 */
function isActiveUser(user) {
  return Boolean(
    user &&
    typeof user === "object" &&
    user._id !== undefined &&
    user._id !== null &&
    (user.status === undefined || user.status === "active"),
  );
}

function hasRole(user, role) {
  return isActiveUser(user) && user.role === role;
}

function isAdmin(user) {
  return hasRole(user, "admin");
}

module.exports = { idOf, sameId, isActiveUser, hasRole, isAdmin };
