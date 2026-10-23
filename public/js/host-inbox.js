// Booking requests page (P09-T02): counts the time left on each request down.
// The server renders the first value and always refuses a late answer (409),
// so this only keeps the page honest while it stays open.
(function () {
  "use strict";

  /** "5 h 12 min", "42 min", "less than a minute", or "" once it has passed. */
  function countdown(msLeft) {
    if (msLeft <= 0) return "";
    const minutes = Math.floor(msLeft / 60000);
    if (minutes < 1) return "less than a minute";
    const hours = Math.floor(minutes / 60);
    if (hours >= 24) return Math.floor(hours / 24) + (Math.floor(hours / 24) === 1 ? " day " : " days ") + (hours % 24) + " h";
    return hours > 0 ? hours + " h " + (minutes % 60) + " min" : minutes + " min";
  }

  globalThis.DimoraHostInboxCore = { countdown };

  if (typeof document === "undefined") return;
  const timers = Array.from(document.querySelectorAll("time[data-expires]"));
  if (timers.length === 0) return;

  function tick() {
    const now = Date.now();
    timers.forEach(function (el) {
      const expires = Number(el.dataset.expires); // milliseconds since 1970, from the server
      if (Number.isNaN(expires)) return;
      const text = countdown(expires - now);
      if (text) {
        el.textContent = text;
        return;
      }
      el.textContent = "no time";
      const card = el.closest(".inbox-card");
      if (card && !card.dataset.expired) {
        card.dataset.expired = "true";
        const note = card.querySelector(".inbox-expiry");
        if (note) note.textContent = "This request has expired. Reload the page to see it released.";
        card.querySelectorAll("button").forEach(function (b) {
          b.disabled = true;
        });
      }
    });
  }

  setInterval(tick, 30000);
})();
