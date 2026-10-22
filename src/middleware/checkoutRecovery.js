// A booking form whose session ran out (P08-T03). Logging in again creates a
// new session with a new CSRF token, so the checkout form that was open in the
// browser is rejected by the CSRF check before any route runs. For that one
// route, instead of the dead-end 403 page, the guest is sent back to the GET
// checkout page for the same stay: it asks them to log in if needed, then
// returns to the checkout with a fresh form. Nothing is booked by the rejected
// request, and the redirect target is built only from the route's own id (24
// hex characters) and strictly checked stay parameters, never from a free-form
// value.
const CHECKOUT_POST = /^\/listings\/([0-9a-f]{24})\/checkout\/?$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const GUESTS = /^\d{1,3}$/;

const MESSAGE =
  "Your session ended before the booking was sent. Nothing was booked. Please check the details and confirm again.";

/**
 * Used as the CSRF middleware's `onInvalid`: returns true when it answered the
 * request (a redirect), false to let the normal 403 happen.
 */
function recoverCheckout(req, res) {
  if (req.method !== "POST") return false;
  const match = CHECKOUT_POST.exec(req.path || "");
  if (!match || typeof req.flash !== "function") return false;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const params = new URLSearchParams();
  if (
    typeof body.in === "string" &&
    DATE_ONLY.test(body.in) &&
    typeof body.out === "string" &&
    DATE_ONLY.test(body.out) &&
    typeof body.guests === "string" &&
    GUESTS.test(body.guests)
  ) {
    params.set("in", body.in);
    params.set("out", body.out);
    params.set("guests", body.guests);
  }
  const query = params.toString();
  req.flash("error", MESSAGE);
  res.redirect(`/listings/${match[1]}/checkout${query ? `?${query}` : ""}`);
  return true;
}

module.exports = { recoverCheckout, CHECKOUT_POST };
