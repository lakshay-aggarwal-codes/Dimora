const { ForbiddenError } = require("../utils/errors");
const { hasRole } = require("../policies/shared");
const { ROLES } = require("../models/user");
const { safeRedirectPath } = require("../utils/safeRedirect");

/** Remembers where the visitor was going and sends them to the login page. */
function redirectToLogin(req, res) {
  req.session.redirectUrl = req.originalUrl;
  req.flash("error", "You must be logged in to do that");
  return res.redirect("/login");
}

function isLoggedIn(req, res, next) {
  if (!req.isAuthenticated()) return redirectToLogin(req, res);
  next();
}

/**
 * Login only: works out where to send the user afterwards and leaves it in
 * `res.locals.redirectUrl` (undefined = use the default). Sources, in order:
 * the page they were stopped at (session), then a `next` form field / query
 * parameter. Either is used only if it is a same-site path.
 */
function saveRedirectUrl(req, res, next) {
  const fromSession = req.session && req.session.redirectUrl;
  if (req.session) delete req.session.redirectUrl;
  const fromForm = (req.body && req.body.next) || (req.query && req.query.next);
  const target =
    safeRedirectPath(fromSession, null) || safeRedirectPath(fromForm, null);
  if (target) res.locals.redirectUrl = target;
  next();
}

/**
 * Route guard for a whole area, e.g. router.use(requireRole("admin")).
 * Anonymous -> login page; logged in without the role (or suspended) -> 403.
 */
function requireRole(role) {
  if (!ROLES.includes(role)) {
    throw new Error(`requireRole: unknown role "${role}"`);
  }
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) return redirectToLogin(req, res);
    if (!hasRole(req.user, role)) throw new ForbiddenError();
    next();
  };
}

module.exports = { redirectToLogin, isLoggedIn, saveRedirectUrl, requireRole };
