// Booking panel (P08-T02) for views/partials/booking-panel.ejs. When the date
// picker fires "dimora:dates-change" (or the guest count changes) it asks
// GET /api/listings/:id/quote and writes the answer into an aria-live="polite"
// region: the price breakdown, or the reasons the stay cannot be booked. The
// Reserve button stays disabled until the server says the stay is bookable.
//
// The amounts are only displayed here: the server computed them in integer
// paise (services/pricing.js), and every piece of text is set with
// textContent, never as markup.
(function () {
  "use strict";

  const DATE_ONLY = /^[1-9]\d{3}-\d{2}-\d{2}$/;

  /** Display only: minor units (paise) -> "₹3,500". */
  function formatMoney(minor, currency) {
    const major = minor / 100;
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: currency || "INR",
        minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(major);
    } catch {
      return (currency || "INR") + " " + major.toFixed(2);
    }
  }

  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  /** The words for one breakdown line (the server sends only a code and numbers). */
  function lineLabel(line, currency) {
    switch (line.code) {
      case "nights":
        return formatMoney(line.unitMinor, currency) + " × " + plural(line.quantity, "night", "nights");
      case "weekend_nights":
        return formatMoney(line.unitMinor, currency) + " × " + plural(line.quantity, "weekend night", "weekend nights");
      case "cleaning":
        return "Cleaning fee";
      case "service_fee":
        return "Service fee";
      case "tax":
        return line.included ? "Taxes (included in the price)" : "Taxes";
      default:
        return "Other charges";
    }
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** "2026-12-05" -> "5 Dec" (text only: no Date, so no time zone can move it). */
  function dayText(value) {
    const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(value));
    return match ? Number(match[2]) + " " + (MONTHS[Number(match[1]) - 1] || match[1]) : String(value);
  }

  /** "2 days earlier" / "1 day later" for a window moved by `days` from the request. */
  function shiftText(days) {
    const n = Math.abs(days);
    return n + (n === 1 ? " day " : " days ") + (days < 0 ? "earlier" : "later");
  }

  const validDate = (value) => typeof value === "string" && DATE_ONLY.test(value);

  /**
   * The nearest free stays of the same length (P15-T04), as plain data.
   * Only windows with a valid quote are kept.
   */
  function describeAlternatives(alternatives) {
    if (!alternatives || typeof alternatives !== "object" || !Array.isArray(alternatives.windows)) return null;
    return {
      radiusDays: Number.isInteger(alternatives.radiusDays) ? alternatives.radiusDays : 14,
      windows: alternatives.windows
        .filter((w) => w && validDate(w.in) && validDate(w.out) && w.quote && Number.isSafeInteger(w.quote.totalMinor))
        .map((w) => ({
          in: w.in,
          out: w.out,
          nights: w.nights,
          label: dayText(w.in) + " to " + dayText(w.out),
          shift: Number.isInteger(w.shiftDays) ? shiftText(w.shiftDays) : "",
          total: formatMoney(w.quote.totalMinor, w.quote.currency),
        })),
    };
  }

  /**
   * What the panel should show for a quote payload, as plain data:
   * { kind: "quote", lines: [{label, amount}], total, nights }, or
   * { kind: "problems", messages: [...], alternatives?: { radiusDays, windows } }.
   */
  function describe(payload) {
    if (!payload || typeof payload !== "object") return { kind: "problems", messages: ["The price is not available right now."] };
    if (payload.bookable && payload.quote) {
      const quote = payload.quote;
      return {
        kind: "quote",
        nights: quote.nights,
        lines: quote.lines.map((line) => ({
          label: lineLabel(line, quote.currency),
          amount: formatMoney(line.amountMinor, quote.currency),
        })),
        total: formatMoney(quote.totalMinor, quote.currency),
      };
    }
    const messages = Array.isArray(payload.problems) ? payload.problems.map((p) => p.message).filter(Boolean) : [];
    const view = { kind: "problems", messages: messages.length ? messages : ["These dates cannot be booked."] };
    const alternatives = describeAlternatives(payload.alternatives);
    if (alternatives) view.alternatives = alternatives;
    return view;
  }

  /** Messages of a 400 / 429 / 5xx answer (the API's own error body). */
  function describeError(status, body) {
    const error = body && body.error;
    if (status === 400 && error && error.fields) {
      return Object.keys(error.fields).map((name) => error.fields[name]);
    }
    if (error && typeof error.message === "string" && status < 500) return [error.message];
    return ["The price could not be loaded. Please try again."];
  }

  function quoteQuery(checkIn, checkOut, guests) {
    return "in=" + encodeURIComponent(checkIn) + "&out=" + encodeURIComponent(checkOut) + "&guests=" + encodeURIComponent(String(guests));
  }

  /** The checkout address for a bookable stay (the page itself is P08-T03). */
  function checkoutHref(base, payload) {
    if (!base || !payload || !payload.bookable) return "";
    return base + "?" + quoteQuery(payload.in, payload.out, payload.guests);
  }

  globalThis.DimoraBookingPanelCore = { formatMoney, lineLabel, describe, describeAlternatives, dayText, shiftText, describeError, quoteQuery, checkoutHref, validDate };

  // ---- the widget ----

  const root = typeof document === "undefined" ? null : document.querySelector("[data-booking-panel]");
  const picker = typeof document === "undefined" ? null : document.querySelector("[data-date-picker]");
  if (!root || !picker) return;

  const quoteUrl = root.dataset.quoteUrl;
  const checkoutBase = root.dataset.checkoutUrl;
  const guestsSelect = root.querySelector("[data-quote-guests]");
  const result = root.querySelector("[data-quote-result]");
  const reserve = root.querySelector("[data-reserve]");
  if (!quoteUrl || !guestsSelect || !result || !reserve) return;

  let checkIn = "";
  let checkOut = "";
  let timer = null;
  let sequence = 0;
  let controller = null;

  function setReserve(href) {
    if (href) {
      reserve.setAttribute("href", href);
      reserve.removeAttribute("aria-disabled");
      reserve.removeAttribute("tabindex");
      reserve.classList.remove("disabled");
    } else {
      reserve.removeAttribute("href");
      reserve.setAttribute("aria-disabled", "true");
      reserve.setAttribute("tabindex", "-1");
      reserve.classList.add("disabled");
    }
  }

  function paragraph(text) {
    const p = document.createElement("p");
    p.className = "small text-body-secondary mb-0";
    p.textContent = text;
    return p;
  }

  function show(node) {
    result.removeAttribute("aria-busy"); // any answer ends the waiting
    result.replaceChildren(node);
  }

  function showMessages(messages) {
    const list = document.createElement("ul");
    list.className = "quote-problems small text-danger-emphasis";
    messages.forEach((message) => {
      const item = document.createElement("li");
      item.textContent = message;
      list.appendChild(item);
    });
    show(list);
  }

  /** The links to other free dates, under the reasons (P15-T04). Text only; the links are plain pages. */
  function appendAlternatives(alternatives) {
    const wrap = document.createElement("div");
    wrap.className = "quote-alternatives mt-2";
    wrap.setAttribute("data-alternatives", "");
    const heading = document.createElement("p");
    heading.className = "small fw-semibold mb-1";
    if (!alternatives.windows.length) {
      heading.textContent = "No free dates of the same length within " + alternatives.radiusDays + " days of these.";
      wrap.appendChild(heading);
      result.appendChild(wrap);
      return;
    }
    heading.textContent = "Free on other dates:";
    const list = document.createElement("ul");
    list.className = "list-unstyled small mb-0";
    const pageBase = String(checkoutBase || "").replace(/\/checkout$/, "");
    alternatives.windows.forEach((w) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.setAttribute("href", pageBase + "?" + quoteQuery(w.in, w.out, guestsSelect.value));
      link.textContent = w.label + " (" + plural(w.nights, "night", "nights") + ", " + w.total + ")";
      item.appendChild(link);
      if (w.shift) {
        const note = document.createElement("span");
        note.className = "text-body-secondary";
        note.textContent = " " + w.shift;
        item.appendChild(note);
      }
      list.appendChild(item);
    });
    wrap.append(heading, list);
    result.appendChild(wrap);
  }

  /** "Checking the price…" for the live region, plus grey blocks shaped like the price lines (P18-T04). */
  function showLoading() {
    show(paragraph("Checking the price…"));
    const stack = document.createElement("div");
    stack.className = "skeleton-stack";
    stack.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i += 1) {
      const line = document.createElement("span");
      line.className = "skeleton";
      stack.appendChild(line);
    }
    const total = document.createElement("span");
    total.className = "skeleton skeleton-total";
    stack.appendChild(total);
    result.appendChild(stack);
    result.setAttribute("aria-busy", "true");
  }

  function showQuote(view) {
    const wrap = document.createElement("div");
    const list = document.createElement("ul");
    list.className = "quote-lines";
    view.lines.forEach((line) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = line.label;
      const amount = document.createElement("span");
      amount.textContent = line.amount;
      item.append(label, amount);
      list.appendChild(item);
    });
    const total = document.createElement("div");
    total.className = "quote-total";
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "Total for " + plural(view.nights, "night", "nights");
    const totalAmount = document.createElement("span");
    totalAmount.textContent = view.total;
    total.append(totalLabel, totalAmount);
    wrap.append(list, total);
    show(wrap);
  }

  async function refresh() {
    const mine = (sequence += 1);
    if (controller) controller.abort();
    if (!validDate(checkIn) || !validDate(checkOut)) {
      setReserve("");
      show(paragraph("Choose your dates to see the price."));
      return;
    }
    setReserve("");
    showLoading();
    controller = typeof AbortController === "undefined" ? null : new AbortController();
    try {
      const response = await fetch(quoteUrl + "?" + quoteQuery(checkIn, checkOut, guestsSelect.value), {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: controller ? controller.signal : undefined,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (mine !== sequence) return; // a newer request replaced this one
      if (!response.ok) {
        showMessages(describeError(response.status, body));
        return;
      }
      const view = describe(body);
      if (view.kind === "quote") {
        showQuote(view);
        setReserve(checkoutHref(checkoutBase, body));
      } else {
        showMessages(view.messages);
        if (view.alternatives) appendAlternatives(view.alternatives);
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (mine !== sequence) return;
      showMessages(describeError(0, null));
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  }

  picker.addEventListener("dimora:dates-change", (event) => {
    const detail = (event && event.detail) || {};
    checkIn = detail.checkIn || "";
    checkOut = detail.checkOut || "";
    schedule();
  });
  guestsSelect.addEventListener("change", schedule);

  // The picker may already have chosen dates (?in=&out=) before this script ran.
  const hiddenIn = picker.querySelector("input[name='checkIn']");
  const hiddenOut = picker.querySelector("input[name='checkOut']");
  checkIn = hiddenIn ? hiddenIn.value : "";
  checkOut = hiddenOut ? hiddenOut.value : "";
  root.removeAttribute("hidden");
  if (checkIn && checkOut) schedule();
})();
