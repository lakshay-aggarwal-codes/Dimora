const { ForbiddenError } = require("../utils/errors");
const { hasRole } = require("../policies/shared");
const { ROLES } = require("../models/user");

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

function saveRedirectUrl(req, res, next) {
  if (req.session.redirectUrl) {
    res.locals.redirectUrl = req.session.redirectUrl;
    delete req.session.redirectUrl;
  }
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
