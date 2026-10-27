// Guest date picker (P07-T04): a small keyboard-accessible range calendar for
// views/partials/date-picker.ejs. No library; it asks
// GET /api/listings/:id/availability for the nights nobody can book and
// disables them. The stay rules (minimum and maximum nights, booking window)
// come from data- attributes; the server checks them again, this only helps.
//
// Dates are handled as whole-day numbers (days since 1970-01-01) with integer
// calendar arithmetic, so no JavaScript Date is built from a string and no time
// zone or daylight-saving change can move a date.
//
// Keyboard: Tab reaches the grid, arrow keys move by day and week, Page Up and
// Page Down change month, Home and End jump to the start and end of the week,
// Enter or Space picks the focused day. Unavailable days stay focusable (so the
// reason can be heard) but cannot be picked. Selecting dates fires a
// "dimora:dates-change" event on the picker element (detail: checkIn,
// checkOut, nights; empty strings when cleared) for the quote panel (P08-T02).
(function () {
  "use strict";

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const DATE_ONLY = /^([1-9]\d{3})-(\d{2})-(\d{2})$/;

  // ---- calendar arithmetic (proleptic Gregorian, integers only) ----

  function daysFromCivil(year, month, day) {
    const y = month <= 2 ? year - 1 : year;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  function civilFromDays(value) {
    const z = value + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor(
      (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
    );
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
  }

  const pad = (n, width) => String(n).padStart(width, "0");

  /** "YYYY-MM-DD" -> day number, or null when it is not a real date. */
  function parse(text) {
    if (typeof text !== "string") return null;
    const match = DATE_ONLY.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1) return null;
    const value = daysFromCivil(year, month, day);
    const back = civilFromDays(value);
    if (back.year !== year || back.month !== month || back.day !== day) return null;
    return value;
  }

  function format(value) {
    const c = civilFromDays(value);
    return pad(c.year, 4) + "-" + pad(c.month, 2) + "-" + pad(c.day, 2);
  }

  /** 0 = Sunday. Day 0 (1970-01-01) was a Thursday. */
  const weekday = (value) => (((value + 4) % 7) + 7) % 7;
  const monthStart = (year, month) => daysFromCivil(year, month, 1);
  function nextMonth(year, month) {
    return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  }
  function previousMonth(year, month) {
    return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  }
  const longDate = (value) => {
    const c = civilFromDays(value);
    return c.day + " " + MONTHS[c.month - 1] + " " + c.year;
  };

  // ---- stay rules (mirror src/services/availability.js; the server decides) ----

  /** First taken night in [from, to), or null. */
  function firstTaken(from, to, taken) {
    for (let d = from; d < to; d += 1) if (taken.has(d)) return d;
    return null;
  }

  /** Earliest and latest possible check-out for a check-in; null when none fits. */
  function checkOutBounds(checkIn, rules, taken) {
    const min = checkIn + rules.minNights;
    const far = checkIn + rules.maxNights;
    const blocked = firstTaken(checkIn, far, taken);
    // A check-out may fall on the first taken night (it is not slept in).
    const max = blocked === null ? far : blocked;
    return min <= max ? { min, max } : null;
  }

  function canCheckIn(day, rules, taken) {
    if (day < rules.today || day > rules.latestCheckIn) return false;
    if (taken.has(day)) return false;
    return checkOutBounds(day, rules, taken) !== null;
  }

  /** A message for the first rule a stay breaks, or "" when it is fine. */
  function problemWith(checkIn, checkOut, rules, taken) {
    if (checkOut <= checkIn) return "Check-out must be after check-in.";
    if (checkIn < rules.today) return "Check-in cannot be in the past.";
    if (checkIn > rules.latestCheckIn) return "That check-in date is too far ahead.";
    const nights = checkOut - checkIn;
    if (nights < rules.minNights) {
      return "The minimum stay is " + rules.minNights + (rules.minNights === 1 ? " night." : " nights.");
    }
    if (nights > rules.maxNights) {
      return "The maximum stay is " + rules.maxNights + (rules.maxNights === 1 ? " night." : " nights.");
    }
    if (firstTaken(checkIn, checkOut, taken) !== null) {
      return "Some of those nights are not available.";
    }
    return "";
  }

  /** Month grid: array of weeks, each 7 day numbers or null for padding. */
  function monthGrid(year, month) {
    const start = monthStart(year, month);
    const next = nextMonth(year, month);
    const count = monthStart(next.year, next.month) - start;
    const cells = [];
    for (let i = 0; i < weekday(start); i += 1) cells.push(null);
    for (let i = 0; i < count; i += 1) cells.push(start + i);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  globalThis.DimoraDatePickerCore = {
    parse, format, weekday, monthGrid, firstTaken, checkOutBounds,
    canCheckIn, problemWith, daysFromCivil, civilFromDays,
  };

  // ---- the widget ----

  const root = typeof document === "undefined" ? null : document.querySelector("[data-date-picker]");
  if (!root) return;

  const url = root.dataset.availabilityUrl;
  const today = parse(root.dataset.today);
  const latestCheckIn = parse(root.dataset.latestCheckIn);
  const minNights = Number(root.dataset.minNights);
  const maxNights = Number(root.dataset.maxNights);
  if (!url || today === null || latestCheckIn === null || !(minNights >= 1) || !(maxNights >= minNights)) {
    return;
  }
  const rules = { today, latestCheckIn, minNights, maxNights };

  const taken = new Set();
  const loadedMonths = new Set();
  let view = civilFromDays(today);
  view = { year: view.year, month: view.month };
  let checkIn = null;
  let checkOut = null;
  let focusDay = today;
  let loadError = false;
  let notice = "";
  let pendingFocus = false;
  let pendingNav = null; // "prev" or "next": the month button to give focus back to after a redraw

  const mount = root.querySelector("[data-date-picker-mount]");
  const hiddenIn = root.querySelector("input[name='checkIn']");
  const hiddenOut = root.querySelector("input[name='checkOut']");
  const summary = root.querySelector("[data-date-summary]");
  const status = root.querySelector("[data-date-status]");
  if (!mount) return;

  const monthKey = (year, month) => pad(year, 4) + "-" + pad(month, 2);

  /** Loads (once) the taken nights of every month touching [from, to). */
  async function ensureLoaded(from, to) {
    const first = civilFromDays(from);
    const last = civilFromDays(to - 1);
    let cursor = { year: first.year, month: first.month };
    const jobs = [];
    for (;;) {
      const key = monthKey(cursor.year, cursor.month);
      if (!loadedMonths.has(key)) {
        const after = nextMonth(cursor.year, cursor.month);
        jobs.push(fetchMonth(key, monthStart(cursor.year, cursor.month), monthStart(after.year, after.month)));
      }
      if (cursor.year === last.year && cursor.month === last.month) break;
      cursor = nextMonth(cursor.year, cursor.month);
    }
    await Promise.all(jobs);
  }

  async function fetchMonth(key, from, to) {
    try {
      const response = await fetch(url + "?from=" + format(from) + "&to=" + format(to), {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("status " + response.status);
      const data = await response.json();
      for (const text of Array.isArray(data.unavailable) ? data.unavailable : []) {
        const day = parse(text);
        if (day !== null) taken.add(day);
      }
      loadedMonths.add(key);
      loadError = false;
    } catch {
      loadError = true;
    }
  }

  const phase = () => (checkIn === null || checkOut !== null ? "in" : "out");

  function inBounds(day) {
    const bounds = checkIn === null ? null : checkOutBounds(checkIn, rules, taken);
    return Boolean(bounds) && day >= bounds.min && day <= bounds.max;
  }

  function isEnabled(day) {
    if (!loadedMonths.has(monthKey(civilFromDays(day).year, civilFromDays(day).month))) return false;
    if (phase() === "out" && inBounds(day)) return true;
    return canCheckIn(day, rules, taken);
  }

  function emit() {
    const nights = checkIn !== null && checkOut !== null ? checkOut - checkIn : 0;
    if (hiddenIn) hiddenIn.value = checkIn === null ? "" : format(checkIn);
    if (hiddenOut) hiddenOut.value = checkOut === null ? "" : format(checkOut);
    root.dispatchEvent(
      new CustomEvent("dimora:dates-change", {
        bubbles: true,
        detail: {
          checkIn: hiddenIn ? hiddenIn.value : "",
          checkOut: hiddenOut ? hiddenOut.value : "",
          nights,
        },
      }),
    );
  }

  async function choose(day) {
    notice = "";
    if (!isEnabled(day)) {
      notice = "That date cannot be chosen.";
    } else if (phase() === "out" && inBounds(day)) {
      checkOut = day;
      emit();
    } else {
      checkIn = day;
      checkOut = null;
      emit();
      // The check-out limits depend on nights up to the longest stay ahead.
      await ensureLoaded(day, day + maxNights + 1);
    }
    focusDay = day;
    pendingFocus = true;
    render();
  }

  function clearDates() {
    checkIn = null;
    checkOut = null;
    notice = "";
    emit();
    render();
  }

  function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function dayLabel(day, enabled) {
    // The weekday first, as a screen reader would say a date: "Monday, 2 November 2026".
    let label = WEEKDAY_NAMES[weekday(day)] + ", " + longDate(day);
    if (day === checkIn) label += ", check-in";
    else if (day === checkOut) label += ", check-out";
    if (!enabled) {
      label += taken.has(day) ? ", unavailable" : ", cannot be chosen";
    }
    return label;
  }

  function buildMonth(year, month) {
    const table = document.createElement("table");
    table.className = "dp-month";
    table.setAttribute("role", "grid");
    const caption = text("caption", MONTHS[month - 1] + " " + year, "dp-title");
    table.appendChild(caption);
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const name of WEEKDAYS) {
      const th = text("th", name);
      th.setAttribute("scope", "col");
      th.setAttribute("aria-label", WEEKDAY_NAMES[WEEKDAYS.indexOf(name)]); // "Su" alone is read as a word
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement("tbody");
    for (const week of monthGrid(year, month)) {
      const row = document.createElement("tr");
      for (const day of week) {
        const cell = document.createElement("td");
        if (day !== null) {
          const enabled = isEnabled(day);
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = String(civilFromDays(day).day);
          button.className = "dp-day";
          button.dataset.day = String(day);
          button.setAttribute("aria-label", dayLabel(day, enabled));
          button.setAttribute("tabindex", day === focusDay ? "0" : "-1");
          if (!enabled) {
            button.setAttribute("aria-disabled", "true");
            button.classList.add(taken.has(day) ? "dp-day--taken" : "dp-day--off");
          }
          if (day === today) button.classList.add("dp-day--today");
          if (day === checkIn || day === checkOut) {
            button.classList.add("dp-day--selected");
            button.setAttribute("aria-pressed", "true");
          } else if (checkIn !== null && checkOut !== null && day > checkIn && day < checkOut) {
            button.classList.add("dp-day--range");
          }
          cell.appendChild(button);
        }
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    table.appendChild(body);
    return table;
  }

  function render() {
    mount.textContent = "";

    const nav = document.createElement("div");
    nav.className = "dp-nav";
    const prev = text("button", "Previous month", "btn btn-sm btn-outline-dark");
    prev.type = "button";
    prev.dataset.nav = "prev";
    const nxt = text("button", "Next month", "btn btn-sm btn-outline-dark");
    nxt.type = "button";
    nxt.dataset.nav = "next";
    const todayMonth = civilFromDays(today);
    const lastMonth = civilFromDays(latestCheckIn);
    prev.disabled = view.year === todayMonth.year && view.month === todayMonth.month;
    nxt.disabled = view.year === lastMonth.year && view.month === lastMonth.month;
    nav.appendChild(prev);
    nav.appendChild(nxt);
    mount.appendChild(nav);

    const months = document.createElement("div");
    months.className = "dp-months";
    months.appendChild(buildMonth(view.year, view.month));
    const second = nextMonth(view.year, view.month);
    months.appendChild(buildMonth(second.year, second.month));
    mount.appendChild(months);

    let message = notice;
    if (!message && loadError) message = "We could not load availability. Check your connection and try again.";
    if (!message) {
      message = checkIn === null ? "Choose your check-in date."
        : checkOut === null ? "Now choose your check-out date."
        : "";
    }
    if (status) status.textContent = message;

    if (summary) {
      summary.textContent = checkIn !== null && checkOut !== null
        ? longDate(checkIn) + " to " + longDate(checkOut) + " (" + (checkOut - checkIn) +
          (checkOut - checkIn === 1 ? " night)" : " nights)")
        : "No dates chosen yet.";
    }

    if (pendingFocus) {
      pendingFocus = false;
      const target = mount.querySelector('[data-day="' + focusDay + '"]');
      if (target) target.focus();
    }

    // The month buttons are rebuilt with the grid, which would drop the
    // keyboard user's focus on the page. Give it back to the button that was
    // pressed, or to the other one when that one is now disabled (the first
    // or last month).
    if (pendingNav) {
      const wanted = pendingNav;
      pendingNav = null;
      const same = mount.querySelector('[data-nav="' + wanted + '"]');
      const other = mount.querySelector('[data-nav="' + (wanted === "next" ? "prev" : "next") + '"]');
      const target = same && !same.disabled ? same : other && !other.disabled ? other : null;
      if (target) target.focus();
    }
  }

  async function showMonth(year, month) {
    view = { year, month };
    await ensureLoaded(monthStart(year, month), monthStart(nextMonth(year, month).year, nextMonth(year, month).month) + 40);
    render();
  }

  async function moveFocus(day) {
    if (day < today || day > latestCheckIn + maxNights) return;
    focusDay = day;
    const c = civilFromDays(day);
    const second = nextMonth(view.year, view.month);
    const visible =
      (c.year === view.year && c.month === view.month) ||
      (c.year === second.year && c.month === second.month);
    pendingFocus = true;
    if (!visible) {
      // Show the month of the focused day first, with its data loaded.
      view = { year: c.year, month: c.month };
      await ensureLoaded(monthStart(c.year, c.month), monthStart(c.year, c.month) + 62);
    }
    render();
  }

  mount.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const nav = target.closest("[data-nav]");
    if (nav) {
      if (nav.disabled) return;
      const to = nav.dataset.nav === "next" ? nextMonth(view.year, view.month) : previousMonth(view.year, view.month);
      pendingNav = nav.dataset.nav;
      showMonth(to.year, to.month);
      return;
    }
    const button = target.closest(".dp-day");
    if (button) choose(Number(button.dataset.day));
  });

  mount.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const button = target.closest(".dp-day");
    if (!button) return;
    const day = Number(button.dataset.day);
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next = null;
    if (event.key in steps) next = day + steps[event.key];
    else if (event.key === "Home") next = day - weekday(day);
    else if (event.key === "End") next = day + (6 - weekday(day));
    else if (event.key === "PageUp" || event.key === "PageDown") {
      const c = civilFromDays(day);
      const m = event.key === "PageDown" ? nextMonth(c.year, c.month) : previousMonth(c.year, c.month);
      next = monthStart(m.year, m.month) + Math.min(c.day, 28) - 1;
    }
    if (next !== null) {
      event.preventDefault();
      moveFocus(next);
    }
  });

  const clearButton = root.querySelector("[data-date-clear]");
  if (clearButton) clearButton.addEventListener("click", clearDates);

  async function start() {
    root.removeAttribute("hidden");
    const second = nextMonth(view.year, view.month);
    await ensureLoaded(monthStart(view.year, view.month), monthStart(second.year, second.month) + 40);
    const wantedIn = parse(root.dataset.initialIn || "");
    const wantedOut = parse(root.dataset.initialOut || "");
    if (wantedIn !== null && wantedOut !== null) {
      await ensureLoaded(wantedIn, wantedOut + 1);
      if (problemWith(wantedIn, wantedOut, rules, taken) === "") {
        checkIn = wantedIn;
        checkOut = wantedOut;
        focusDay = wantedIn;
        const c = civilFromDays(wantedIn);
        view = { year: c.year, month: c.month };
        await ensureLoaded(monthStart(c.year, c.month), monthStart(c.year, c.month) + 40);
        emit();
      }
    }
    render();
  }
  start();
})();
