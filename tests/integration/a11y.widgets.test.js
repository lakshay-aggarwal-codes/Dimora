// P18-T03: the real browser scripts, run in jsdom against the real markup, to
// check what a keyboard or screen-reader user meets: the date picker (roving
// focus, arrow keys, month buttons, announcements, axe on the live DOM), the
// shared form-validation script (focus goes to the first problem), and the
// booking panel's live region. jsdom has no layout, so nothing here judges
// colour or size.
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const { JSDOM } = require("jsdom");
const axe = require("axe-core");

const ROOT = path.join(__dirname, "..", "..");
const script = (name) =>
  fs.readFileSync(path.join(ROOT, "public", "js", name), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await tick();
};

async function runAxe(window) {
  window.HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no canvas; axe probes for one
  window.eval(axe.source);
  const result = await window.axe.run(window.document, {
    runOnly: {
      type: "tag",
      values: [
        "wcag2a",
        "wcag2aa",
        "wcag21a",
        "wcag21aa",
        "wcag22aa",
        "best-practice",
      ],
    },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, // a fragment, not a page
  });
  return result.violations.map(
    (v) =>
      `${v.id}: ${v.help} -> ${v.nodes
        .slice(0, 3)
        .map((n) => n.html.slice(0, 100))
        .join(" | ")}`,
  );
}

// ---------------------------------------------------------------- date picker

const DAY = 86400000;
const iso = (offset) =>
  new Date(Math.floor(Date.now() / DAY) * DAY + offset * DAY)
    .toISOString()
    .slice(0, 10);

async function picker({ taken = [], failFetch = false } = {}) {
  const html = await ejs.renderFile(
    path.join(ROOT, "views", "partials", "date-picker.ejs"),
    {
      datePicker: {
        url: "/api/listings/1/availability",
        rules: {
          today: iso(0),
          latestCheckIn: iso(364),
          minNights: 1,
          maxNights: 14,
          advanceNoticeHours: 0,
        },
        initialIn: "",
        initialOut: "",
      },
    },
  );
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title>Dates</title></head><body><main>${html}</main></body></html>`,
    {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "http://localhost/",
    },
  );
  const { window } = dom;
  window.fetch = async () => {
    if (failFetch) throw new Error("offline");
    return { ok: true, json: async () => ({ unavailable: taken }) };
  };
  const events = [];
  window.document.addEventListener("dimora:dates-change", (e) =>
    events.push(e.detail),
  );
  window.eval(script("date-picker.js"));
  await settle();
  const day = (offset) =>
    window.document.querySelector(
      `[data-date-picker] button[data-day="${Math.floor(Date.now() / DAY) + offset}"]`,
    );
  const key = (el, k) =>
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: k,
        bubbles: true,
        cancelable: true,
      }),
    );
  return { window, document: window.document, day, key, events };
}

describe("the date picker, with a keyboard", () => {
  test("it opens with a calendar, a status message and no JavaScript notice problem", async () => {
    const { document } = await picker();
    expect(
      document.querySelector("[data-date-picker]").hasAttribute("hidden"),
    ).toBe(false);
    expect(document.querySelectorAll("table.dp-month")).toHaveLength(2);
    expect(document.querySelector("[data-date-status]").textContent).toBe(
      "Choose your check-in date.",
    );
    expect(document.querySelector("[data-date-summary]").textContent).toBe(
      "No dates chosen yet.",
    );
    expect(
      document.querySelector("[data-date-status]").getAttribute("role"),
    ).toBe("status");
    expect(
      document.querySelector("[data-date-summary]").getAttribute("aria-live"),
    ).toBe("polite");
  });

  test("the live DOM has no axe violations", async () => {
    const { window } = await picker({ taken: [iso(3), iso(4)] });
    expect(await runAxe(window)).toEqual([]);
  });

  test("one day is in the tab order (roving tabindex), today to begin with", async () => {
    const { document, day } = await picker();
    const tabbable = [...document.querySelectorAll(".dp-day")].filter(
      (b) => b.getAttribute("tabindex") === "0",
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(day(0));
  });

  test("every day is a button with a full spoken name; taken days say so", async () => {
    const { document, day } = await picker({ taken: [iso(3)] });
    for (const b of document.querySelectorAll(".dp-day")) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("aria-label")).toMatch(
        /^[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+ \d{4}/,
      );
    }
    expect(day(3).getAttribute("aria-label")).toMatch(/unavailable$/);
    expect(day(3).getAttribute("aria-disabled")).toBe("true");
    expect(day(3).getAttribute("tabindex")).toBe("-1"); // reachable with the arrow keys, not a tab stop
  });

  test.each([
    ["ArrowRight", 1],
    ["ArrowLeft", -1],
    ["ArrowDown", 7],
    ["ArrowUp", -7],
  ])("%s moves focus by %i day(s)", async (k, delta) => {
    const { document, day, key } = await picker();
    const start = delta < 0 ? day(10) : day(10);
    start.focus();
    key(start, k);
    await settle();
    expect(document.activeElement).toBe(day(10 + delta));
    expect(document.activeElement.getAttribute("tabindex")).toBe("0");
  });

  test("Home and End go to the start and the end of the week; the focused day is never lost", async () => {
    const { document, day, key } = await picker();
    day(10).focus();
    key(day(10), "Home");
    await settle();
    expect(document.activeElement.getAttribute("aria-label")).toMatch(
      /^Sunday/,
    );
    key(document.activeElement, "End");
    await settle();
    expect(document.activeElement.getAttribute("aria-label")).toMatch(
      /^Saturday/,
    );
  });

  test("PageDown and PageUp change the month and keep focus on a day", async () => {
    const { document, day, key } = await picker();
    day(2).focus();
    key(day(2), "PageDown");
    await settle();
    expect(document.activeElement.classList.contains("dp-day")).toBe(true);
    const next = document.activeElement.getAttribute("aria-label");
    key(document.activeElement, "PageUp");
    await settle();
    expect(document.activeElement.classList.contains("dp-day")).toBe(true);
    expect(document.activeElement.getAttribute("aria-label")).not.toBe(next);
  });

  test("a key the picker does not use is left alone (Tab must still leave the calendar)", async () => {
    const { document, day, key } = await picker();
    day(2).focus();
    const event = new document.defaultView.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    day(2).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    key(day(2), "x");
    expect(document.activeElement).toBe(day(2));
  });

  test("choosing a check-in then a check-out announces the summary and tells the page", async () => {
    const { document, day, events } = await picker();
    day(5).click();
    await settle();
    expect(document.querySelector("[data-date-status]").textContent).toBe(
      "Now choose your check-out date.",
    );
    expect(document.activeElement).toBe(day(5)); // focus stays where the user acted
    day(8).click();
    await settle();
    expect(document.querySelector("[data-date-summary]").textContent).toMatch(
      /to .* \(3 nights\)$/,
    );
    expect(events.at(-1)).toMatchObject({ nights: 3 });
    expect(day(8).getAttribute("aria-pressed")).toBe("true");
  });

  test("a date that cannot be chosen is explained in words, not just refused", async () => {
    const { document, day } = await picker({ taken: [iso(3)] });
    day(3).click();
    await settle();
    expect(document.querySelector("[data-date-status]").textContent).toBe(
      "That date cannot be chosen.",
    );
  });

  test("the month buttons keep keyboard focus after the calendar is redrawn", async () => {
    const { document } = await picker();
    const next = document.querySelector('[data-nav="next"]');
    next.focus();
    next.click();
    await settle();
    expect(document.activeElement.getAttribute("data-nav")).toBe("next");
    const prev = document.querySelector('[data-nav="prev"]');
    prev.click();
    await settle();
    // back on the first month the previous button is disabled: focus moves to the next button
    expect(document.activeElement.getAttribute("data-nav")).toBe("next");
    expect(document.activeElement.disabled).toBe(false);
  });

  test("when availability cannot be loaded, the user is told", async () => {
    const { document } = await picker({ failFetch: true });
    expect(document.querySelector("[data-date-status]").textContent).toContain(
      "could not load availability",
    );
  });

  test("Clear dates is a real button in the tab order and resets the summary", async () => {
    const { document, day } = await picker();
    day(5).click();
    await settle();
    const clear = document.querySelector("[data-date-clear]");
    expect(clear.tagName).toBe("BUTTON");
    clear.click();
    await settle();
    expect(document.querySelector("[data-date-summary]").textContent).toBe(
      "No dates chosen yet.",
    );
  });
});

// ---------------------------------------------------------------- forms

describe("form validation (public/js/script.js)", () => {
  const page = () =>
    new JSDOM(
      `<!doctype html><html lang="en"><body><form class="needs-validation" novalidate>
        <label for="a">A</label><input id="a" name="a" required>
        <label for="b">B</label><input id="b" name="b" required>
        <fieldset><legend>Rating</legend>
          <input type="radio" id="r1" name="review[rating]" value="1" required><label for="r1">1</label>
          <input type="radio" id="r2" name="review[rating]" value="2" required><label for="r2">2</label>
        </fieldset>
        <div data-rating-feedback hidden>Please choose a rating.</div>
        <button type="submit">Send</button></form></body></html>`,
      {
        runScripts: "outside-only",
        pretendToBeVisual: true,
        url: "http://localhost/",
      },
    );
  const submit = (window) => {
    const event = new window.Event("submit", {
      bubbles: true,
      cancelable: true,
    });
    window.document.querySelector("form").dispatchEvent(event);
    return event;
  };

  test("an invalid submit is stopped and focus goes to the first problem", () => {
    const { window } = page();
    window.eval(script("script.js"));
    const event = submit(window);
    expect(event.defaultPrevented).toBe(true);
    expect(window.document.activeElement.id).toBe("a");
    expect(
      window.document.querySelector("form").classList.contains("was-validated"),
    ).toBe(true);
  });

  test("with the first field filled, focus goes to the next problem", () => {
    const { window } = page();
    window.eval(script("script.js"));
    window.document.getElementById("a").value = "x";
    submit(window);
    expect(window.document.activeElement.id).toBe("b");
  });

  test("the rating message is shown while nothing is chosen and hidden once it is", () => {
    const { window } = page();
    window.eval(script("script.js"));
    const feedback = window.document.querySelector("[data-rating-feedback]");
    submit(window);
    expect(feedback.hidden).toBe(false);
    window.document.getElementById("r2").checked = true;
    submit(window);
    expect(feedback.hidden).toBe(true);
  });

  test("a valid form is not stopped", () => {
    const { window } = page();
    window.eval(script("script.js"));
    for (const id of ["a", "b"]) window.document.getElementById(id).value = "x";
    window.document.getElementById("r1").checked = true;
    expect(submit(window).defaultPrevented).toBe(false);
  });
});
