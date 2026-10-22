// Checkout page (P08-T03): the submit button turns off after the first click,
// so a double click cannot send the booking twice. (The server also treats a
// repeated idempotency key as the same booking: this only avoids the noise.)
// The page works without this script; it only adds the guard.
(function () {
  "use strict";

  const form = document.querySelector("[data-checkout-form]");
  if (!form) return;
  const button = form.querySelector("[data-submit-once]");
  if (!button) return;
  const label = button.textContent;

  form.addEventListener("submit", function (event) {
    if (form.dataset.sending === "true") {
      event.preventDefault();
      return;
    }
    form.dataset.sending = "true";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Sending...";
  });

  // Back button: the browser may restore the page with the button still off.
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    form.dataset.sending = "false";
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  });
})();
