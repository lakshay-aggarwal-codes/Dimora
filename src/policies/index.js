// Policy registry (P02-T06). One place that says who may do what.
//
//   can("listing:edit", req.user, listing)   -> true | false
//
// Policies are pure functions `(user, resource) => boolean`: no database, no
// request object, so they are easy to test (tests/unit/policies.test.js) and
// safe to call from views (`can(...)` in res.locals). Add new actions here and
// extend the matrix test; the `authorize()` middleware and the views pick them
// up by name.
const listing = require("./listing");
const review = require("./review");
const admin = require("./admin");
const reservation = require("./reservation");
const report = require("./report");
const conversation = require("./conversation");
const { isAdmin, hasRole } = require("./shared");

const POLICIES = {
  "listing:create": listing.create,
  "listing:edit": listing.edit,
  "listing:delete": listing.delete,
  "review:create": review.create,
  "review:delete": review.delete,
  "reservation:view": reservation.view,
  "reservation:respond": reservation.respond,
  "reservation:cancel": reservation.cancel,
  "report:create": report.create,
  "conversation:start": conversation.start,
  "conversation:view": conversation.view,
  "conversation:send": conversation.send,
  "admin:access": admin.access,
};

/**
 * @param {string} action   e.g. "listing:edit"
 * @param {object} [user]   req.user, undefined when anonymous
 * @param {object} [resource] the listing/review the action applies to
 * @returns {boolean}
 * @throws {Error} for an unknown action (a typo must fail loudly, not allow or deny silently)
 */
function can(action, user, resource) {
  const policy = POLICIES[action];
  if (!policy) throw new Error(`Unknown policy action: "${action}"`);
  return Boolean(policy(user, resource));
}

function actions() {
  return Object.keys(POLICIES);
}

module.exports = { can, actions, isAdmin, hasRole };
