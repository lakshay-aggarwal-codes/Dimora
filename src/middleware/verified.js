// "Confirm your email first" (P02-T05). Publishing a listing and booking a stay
// need a confirmed address. Called at the top of the controller action (not as
// route middleware, so the route guards the authorization matrix checks stay as
// they are):
//
//   if (!ensureVerifiedEmail(req, res)) return;
//
// Returns true when the request may go on. Otherwise it has already answered
// (a flash message and a redirect to /verify-email/needed) and returns false.
// The server decides; nothing the browser sends can skip it.
// With EMAIL_VERIFICATION_REQUIRED=false (app.locals.emailVerificationRequired)
// it always returns true.
const MESSAGE =
  "Confirm your email address first. You need a confirmed address to publish a listing or book a stay.";

function isEmailVerified(user) {
  return Boolean(user && user.emailVerifiedAt);
}

function ensureVerifiedEmail(req, res) {
  if (!req.app.locals.emailVerificationRequired) return true;
  if (isEmailVerified(req.user)) return true;
  req.flash("error", MESSAGE);
  res.redirect("/verify-email/needed");
  return false;
}

module.exports = { ensureVerifiedEmail, isEmailVerified, MESSAGE };
