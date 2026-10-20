// Who may open the admin area (P14-T01). `(user) => boolean`.
// Only an active admin: a suspended or deleted admin account has no access.
const { isAdmin } = require("./shared");

function access(user) {
  return isAdmin(user);
}

module.exports = { access };
