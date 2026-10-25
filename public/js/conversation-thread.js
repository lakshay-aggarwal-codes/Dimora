// A conversation page (P11-T03): while the newest page is open and the tab is
// visible, asks GET /api/conversations/:id/messages every 15 seconds and
// redraws the list when there is something new. Message text is only ever put
// in with textContent (never as HTML). The page works without this script:
// the reply form posts and the page reloads.
(function () {
  "use strict";

  /** Seconds between asks, kept between 15 and 20 (the page says 15). */
  function pollSeconds(raw) {
    if (raw === null || raw === undefined || raw === "") return 15;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 15;
    return Math.min(20, Math.max(15, Math.round(n)));
  }

  /** The messages in a response body, or null when it is not usable. */
  function parseMessages(body) {
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
      return null;
    }
    const ok = body.messages.every(
      (m) =>
        m &&
        typeof m.id === "string" &&
        typeof m.body === "string" &&
        typeof m.mine === "boolean",
    );
    return ok ? body.messages : null;
  }

  /** True when the page already shows exactly these messages. */
  function sameMessages(shownIds, messages) {
    return (
      shownIds.length === messages.length &&
      shownIds.every((id, i) => id === messages[i].id)
    );
  }

  globalThis.DimoraThreadCore = {
    pollSeconds: pollSeconds,
    parseMessages: parseMessages,
    sameMessages: sameMessages,
  };

  if (typeof document === "undefined") return;
  const list = document.querySelector("[data-message-list]");
  if (!list || typeof fetch !== "function") return;
  const url = list.getAttribute("data-messages-url");
  if (!url) return; // an older page: nothing to keep current
  const otherName = list.getAttribute("data-other-name") || "";
  const empty = document.querySelector("[data-empty]");
  const delay = pollSeconds(list.getAttribute("data-poll-seconds")) * 1000;

  function shownIds() {
    return Array.prototype.map.call(list.children, function (li) {
      return li.getAttribute("data-id");
    });
  }

  function build(message) {
    const li = document.createElement("li");
    li.className = "message" + (message.mine ? " message-mine" : "");
    li.setAttribute("data-id", message.id);
    const meta = document.createElement("p");
    meta.className = "message-meta";
    const who = document.createElement("strong");
    who.textContent = message.mine ? "You" : otherName;
    const time = document.createElement("time");
    time.setAttribute("datetime", message.iso || "");
    time.textContent = message.when || "";
    meta.appendChild(who);
    meta.appendChild(document.createTextNode(" \u00b7 "));
    meta.appendChild(time);
    const text = document.createElement("p");
    text.className = "message-body";
    text.textContent = message.body;
    li.appendChild(meta);
    li.appendChild(text);
    return li;
  }

  function nearBottom() {
    if (typeof window === "undefined" || !document.body) return false;
    return (
      window.innerHeight + window.scrollY >= document.body.offsetHeight - 200
    );
  }

  function render(messages) {
    const stick = nearBottom();
    list.replaceChildren.apply(list, messages.map(build));
    if (empty) empty.hidden = messages.length > 0;
    if (stick && list.lastElementChild && list.lastElementChild.scrollIntoView) {
      list.lastElementChild.scrollIntoView({ block: "nearest" });
    }
  }

  let timer = null;
  let inFlight = false;
  let stopped = false;

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
        if (response.status === 401 || response.status === 404) {
          stopped = true; // signed out, or no longer ours
          return null;
        }
        return response.ok ? response.json() : null;
      })
      .then(function (body) {
        const messages = parseMessages(body);
        if (messages && !sameMessages(shownIds(), messages)) render(messages);
      })
      .catch(function () {
        // Keep what is shown; the next ask tries again.
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

  schedule();
})();
