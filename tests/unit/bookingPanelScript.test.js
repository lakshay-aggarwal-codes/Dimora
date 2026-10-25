// public/js/booking-panel.js: the pure display logic, in a Node vm. The widget
// itself needs a browser (see docs/tasks/P08-T02.md for the checks).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "booking-panel.js"),
  "utf8",
);
function load() {
  const context = { document: { querySelector: () => null }, Intl };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context.DimoraBookingPanelCore;
}
const core = load();
// Node's ICU may separate the symbol with a no-break space; compare without it.
const plain = (text) => text.replace(/\u00a0/g, " ");

describe("formatMoney", () => {
  test("whole rupees have no decimals, paise do", () => {
    expect(plain(core.formatMoney(350000, "INR"))).toBe("₹3,500");
    expect(plain(core.formatMoney(350050, "INR"))).toBe("₹3,500.50");
    expect(plain(core.formatMoney(12345600, "INR"))).toBe("₹1,23,456");
  });
  test("an unknown currency falls back to a plain code and amount", () => {
    expect(plain(core.formatMoney(1000, "ZZZZ"))).toBe("ZZZZ 10.00");
  });
});

describe("lineLabel", () => {
  test("each code has words", () => {
    expect(
      plain(
        core.lineLabel(
          { code: "nights", unitMinor: 250000, quantity: 2 },
          "INR",
        ),
      ),
    ).toBe("₹2,500 × 2 nights");
    expect(
      plain(
        core.lineLabel(
          { code: "nights", unitMinor: 250000, quantity: 1 },
          "INR",
        ),
      ),
    ).toBe("₹2,500 × 1 night");
    expect(
      plain(
        core.lineLabel(
          { code: "weekend_nights", unitMinor: 300000, quantity: 1 },
          "INR",
        ),
      ),
    ).toBe("₹3,000 × 1 weekend night");
    expect(core.lineLabel({ code: "cleaning" })).toBe("Cleaning fee");
    expect(core.lineLabel({ code: "service_fee" })).toBe("Service fee");
    expect(core.lineLabel({ code: "tax" })).toBe("Taxes");
    expect(core.lineLabel({ code: "tax", included: true })).toBe(
      "Taxes (included in the price)",
    );
    expect(core.lineLabel({ code: "mystery" })).toBe("Other charges");
  });
});

describe("describe", () => {
  const quote = {
    nights: 3,
    currency: "INR",
    totalMinor: 1000000,
    lines: [
      { code: "nights", unitMinor: 250000, quantity: 2, amountMinor: 500000 },
      { code: "cleaning", amountMinor: 50000 },
    ],
  };
  test("a bookable payload becomes lines and a total", () => {
    const view = core.describe({ bookable: true, quote });
    expect(view.kind).toBe("quote");
    expect(view.nights).toBe(3);
    expect(view.lines.map((l) => plain(l.amount))).toEqual(["₹5,000", "₹500"]);
    expect(plain(view.total)).toBe("₹10,000");
  });
  test("reasons are shown as they came", () => {
    expect(
      core.describe({
        bookable: false,
        problems: [
          { message: "The minimum stay is 2 nights." },
          { message: "x" },
        ],
      }),
    ).toEqual({
      kind: "problems",
      messages: ["The minimum stay is 2 nights.", "x"],
    });
  });
  test("nothing usable still says something", () => {
    expect(core.describe({ bookable: false, problems: [] }).messages).toEqual([
      "These dates cannot be booked.",
    ]);
    expect(core.describe(null).kind).toBe("problems");
    expect(core.describe({ bookable: true }).kind).toBe("problems");
  });
});

describe("describeError", () => {
  test("a 400 shows each field message", () => {
    expect(
      core.describeError(400, {
        error: {
          fields: {
            in: "Check-in is required.",
            guests: "Guests must be a whole number, 1 or more.",
          },
        },
      }),
    ).toEqual([
      "Check-in is required.",
      "Guests must be a whole number, 1 or more.",
    ]);
  });
  test("a 429 or 404 shows its own message; a 5xx or no answer a generic one", () => {
    expect(
      core.describeError(429, { error: { message: "Too many price checks." } }),
    ).toEqual(["Too many price checks."]);
    expect(
      core.describeError(500, { error: { message: "secret detail" } }),
    ).toEqual(["The price could not be loaded. Please try again."]);
    expect(core.describeError(0, null)).toEqual([
      "The price could not be loaded. Please try again.",
    ]);
  });
});

describe("query and checkout address", () => {
  test("quoteQuery encodes", () => {
    expect(core.quoteQuery("2026-11-02", "2026-11-05", 3)).toBe(
      "in=2026-11-02&out=2026-11-05&guests=3",
    );
  });
  test("the checkout link exists only for a bookable stay", () => {
    const ok = {
      bookable: true,
      in: "2026-11-02",
      out: "2026-11-05",
      guests: 2,
    };
    expect(core.checkoutHref("/listings/abc/checkout", ok)).toBe(
      "/listings/abc/checkout?in=2026-11-02&out=2026-11-05&guests=2",
    );
    expect(
      core.checkoutHref("/listings/abc/checkout", { ...ok, bookable: false }),
    ).toBe("");
    expect(core.checkoutHref("", ok)).toBe("");
  });
  test("validDate", () => {
    expect(core.validDate("2026-11-02")).toBe(true);
    for (const bad of ["", "2026-1-2", "x", null, 5])
      expect(core.validDate(bad)).toBe(false);
  });
});

describe("alternatives (P15-T04)", () => {
  const payload = (over = {}) => ({
    bookable: false,
    problems: [{ code: "nights_unavailable", message: "These nights are not available: 2026-12-11." }],
    quote: null,
    alternatives: {
      radiusDays: 14,
      windows: [
        { in: "2026-12-14", out: "2026-12-17", nights: 3, shiftDays: 4, quote: { totalMinor: 800000, currency: "INR" } },
        { in: "2026-12-06", out: "2026-12-09", nights: 3, shiftDays: -4, quote: { totalMinor: 750000, currency: "INR" } },
      ],
    },
    ...over,
  });

  test("describe keeps the reasons and adds the windows with a label, the shift and the price", () => {
    const view = core.describe(payload());
    expect(view.kind).toBe("problems");
    expect(view.messages).toEqual(["These nights are not available: 2026-12-11."]);
    expect(view.alternatives.radiusDays).toBe(14);
    expect(view.alternatives.windows.map((w) => [w.in, w.out, w.nights, w.label, w.shift, plain(w.total)])).toEqual([
      ["2026-12-14", "2026-12-17", 3, "14 Dec to 17 Dec", "4 days later", "₹8,000"],
      ["2026-12-06", "2026-12-09", 3, "6 Dec to 9 Dec", "4 days earlier", "₹7,500"],
    ]);
  });

  test("an empty list is kept (the panel says nothing is free nearby); no alternatives key means none", () => {
    expect(core.describe(payload({ alternatives: { radiusDays: 14, windows: [] } })).alternatives).toEqual({ radiusDays: 14, windows: [] });
    expect("alternatives" in core.describe(payload({ alternatives: undefined }))).toBe(false);
    expect("alternatives" in core.describe({ bookable: false, problems: [{ message: "x" }] })).toBe(false);
  });

  test("a bookable quote carries no alternatives", () => {
    const view = core.describe({ bookable: true, quote: { nights: 1, currency: "INR", totalMinor: 100, lines: [] }, alternatives: { windows: [] } });
    expect(view.kind).toBe("quote");
    expect(view.alternatives).toBeUndefined();
  });

  test("windows with bad dates or a bad price are left out, and junk is ignored", () => {
    const bad = payload({
      alternatives: {
        radiusDays: "14",
        windows: [
          null,
          { in: "tomorrow", out: "2026-12-17", nights: 3, quote: { totalMinor: 1 } },
          { in: "2026-12-14", out: "2026-12-17", nights: 3, quote: { totalMinor: "800000" } },
          { in: "2026-12-14", out: "2026-12-17", nights: 3 },
          { in: "2026-12-14", out: "2026-12-17", nights: 3, quote: { totalMinor: 800000, currency: "INR" } },
        ],
      },
    });
    const view = core.describe(bad);
    expect(view.alternatives.radiusDays).toBe(14);
    expect(view.alternatives.windows).toHaveLength(1);
    expect(core.describeAlternatives("nope")).toBeNull();
    expect(core.describeAlternatives({ windows: "x" })).toBeNull();
  });

  test("dayText and shiftText are text only", () => {
    expect(core.dayText("2026-01-05")).toBe("5 Jan");
    expect(core.dayText("2026-12-31")).toBe("31 Dec");
    expect(core.dayText("whatever")).toBe("whatever");
    expect(core.shiftText(1)).toBe("1 day later");
    expect(core.shiftText(-1)).toBe("1 day earlier");
    expect(core.shiftText(-14)).toBe("14 days earlier");
  });
});
