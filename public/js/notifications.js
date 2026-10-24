// Navbar bell (P11-T01): shows how many notifications are unread. Asks
// GET /api/notifications/count every 30 seconds while the tab is visible,
// stops while it is hidden (and asks again when it comes back), and stops for
// good if the server says the member is signed out. The link to
// /notifications works without this script; the server decides what is counted.
(function () {
  "use strict";

  /** "3", "99+" */
  function badgeText(count) {
    return count > 99 ? "99+" : String(count);
  }

  /** The bell's accessible name: "Notifications" or "Notifications, 3 unread". */
  function countLabel(count) {
    return count > 0 ? "Notifications, " + count + " unread" : "Notifications";
  }

  /** The unread count in a response body, or null when it is not usable. */
  function parseCount(body) {
    if (!body || typeof body !== "object") return null;
    const n = body.unread;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
  }

  /** Seconds between asks: the page's value kept between 10 and 300, else 30. */
  function pollSeconds(raw) {
    if (raw === null || raw === undefined || raw === "") return 30;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 30;
    return Math.min(300, Math.max(10, Math.round(n)));
  }

  globalThis.DimoraNotificationsCore = {
    badgeText: badgeText,
    countLabel: countLabel,
    parseCount: parseCount,
    pollSeconds: pollSeconds,
  };

  if (typeof document === "undefined") return;
  const bell = document.querySelector("[data-notifications-bell]");
  if (!bell || typeof fetch !== "function") return;
  const url = bell.getAttribute("data-count-url");
  if (!url) return;
  const badge = bell.querySelector("[data-bell-count]");
  const label = bell.querySelector("[data-bell-label]");
  const delay = pollSeconds(bell.getAttribute("data-poll-seconds")) * 1000;

  let timer = null;
  let inFlight = false;
  let stopped = false;

  function render(count) {
    if (badge) {
      badge.textContent = badgeText(count);
      badge.hidden = count === 0;
    }
    if (label) label.textContent = countLabel(count);
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped || document.hidden) return;
    timer = setTimeout(poll, delay);
  }

  function poll() {
    if (stopped || inFlight) return;
    inFlight = true;
    fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        if (response.status === 401) {
          stopped = true;
          return null;
        }
        return response.ok ? response.json() : null;
      })
      .then(function (body) {
        const count = parseCount(body);
        if (count !== null) render(count);
      })
      .catch(function () {
        // A failed ask keeps the last number; the next one tries again.
      })
      .then(function () {
        inFlight = false;
        schedule();
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) clearTimeout(timer);
    else poll();
  });

  poll();
})();
