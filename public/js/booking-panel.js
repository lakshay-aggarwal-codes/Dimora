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

  /**
   * What the panel should show for a quote payload, as plain data:
   * { kind: "quote", lines: [{label, amount}], total, nights }, or
   * { kind: "problems", messages: [...] }.
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
    return { kind: "problems", messages: messages.length ? messages : ["These dates cannot be booked."] };
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

  const validDate = (value) => typeof value === "string" && DATE_ONLY.test(value);

  globalThis.DimoraBookingPanelCore = { formatMoney, lineLabel, describe, describeError, quoteQuery, checkoutHref, validDate };

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
    show(paragraph("Checking the price…"));
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
