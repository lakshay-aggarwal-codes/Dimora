// P08-T03: the checkout view model adds words and highlights, never prices.
const {
  buildCheckoutView,
  lineLabel,
  dayLabel,
  encodeLines,
  decodeLines,
} = require("../../src/services/checkout");
const pricing = require("../../src/services/pricing");
const {
  cancellationText,
  NO_POLICY_TEXT,
  POLICY_TEXT,
} = require("../../src/config/cancellationText");
const { CANCELLATION_POLICY_VALUES } = require("../../src/config/constants");
const { parseDateOnly } = require("../../src/utils/dates");

const listing = (extra = {}) => ({
  _id: "507f1f77bcf86cd799439011",
  title: "Sea house",
  address: { city: "Goa" },
  country: "India",
  pricing: { nightlyMinor: 250000, cleaningFeeMinor: 50000, currency: "INR" },
  images: [{ url: "https://img/x.jpg" }],
  instantBook: false,
  cancellationPolicy: "flexible",
  checkInTime: "14:00",
  checkOutTime: "11:00",
  houseRules: "  Quiet after 10 pm.  ",
  ...extra,
});

function payload(doc = listing(), guests = 2) {
  const quote = pricing.quote({
    listing: doc,
    checkIn: parseDateOnly("2026-12-01"),
    checkOut: parseDateOnly("2026-12-04"),
    guests,
  });
  return {
    in: "2026-12-01",
    out: "2026-12-04",
    guests,
    bookable: true,
    problems: [],
    quote,
    expectedTotalMinor: quote.totalMinor,
  };
}

describe("buildCheckoutView", () => {
  test("lines and total are exactly the pricing service's", () => {
    const p = payload();
    const view = buildCheckoutView(listing(), p, {
      idempotencyKey: "k".repeat(16),
    });
    expect(view.lines.map((l) => [l.code, l.amountMinor])).toEqual(
      p.quote.lines.map((l) => [l.code, l.amountMinor]),
    );
    expect(view.totalMinor).toBe(p.quote.totalMinor);
    expect(view.expectedTotalMinor).toBe(p.quote.totalMinor);
    expect(view.currency).toBe("INR");
    expect(view.change).toBeNull();
    expect(view.lines.some((l) => l.changed)).toBe(false);
  });

  test("describes the stay, the listing, the booking mode and the key", () => {
    const view = buildCheckoutView(listing({ instantBook: true }), payload(), {
      idempotencyKey: "abc12345",
    });
    expect(view.stay).toEqual(
      expect.objectContaining({
        in: "2026-12-01",
        out: "2026-12-04",
        nights: 3,
        guests: 2,
        guestsLabel: "2 guests",
      }),
    );
    // punctuation differs between ICU versions ("Tue, 1 Dec, 2026" / "Tue, 1 Dec 2026")
    expect(view.stay.inLabel).toMatch(/^Tue,? 1 Dec,? 2026$/);
    expect(view.listing).toEqual(
      expect.objectContaining({
        title: "Sea house",
        place: "Goa, India",
        houseRules: "Quiet after 10 pm.",
        coverUrl: "https://img/x.jpg",
      }),
    );
    expect(view.instant).toBe(true);
    expect(view.idempotencyKey).toBe("abc12345");
    expect(buildCheckoutView(listing(), payload(), {}).stay.guestsLabel).toBe(
      "2 guests",
    );
    expect(
      buildCheckoutView(listing(), payload(listing(), 1), {}).stay.guestsLabel,
    ).toBe("1 guest");
  });

  test("a changed total highlights the lines that differ, and reports the difference", () => {
    const p = payload();
    const old = p.quote.lines
      .map(
        (l) =>
          `${l.code}:${l.code === "nights" ? l.amountMinor - 1000 : l.amountMinor}`,
      )
      .join(";");
    const view = buildCheckoutView(listing(), p, {
      previousTotalMinor: p.quote.totalMinor - 1500,
      previousLines: old,
      idempotencyKey: "k",
    });
    expect(view.change).toEqual({
      previousTotalMinor: p.quote.totalMinor - 1500,
      newTotalMinor: p.quote.totalMinor,
      differenceMinor: 1500,
    });
    expect(view.lines.find((l) => l.code === "nights").changed).toBe(true);
    expect(view.lines.find((l) => l.code === "cleaning").changed).toBe(false);
  });

  test("an unchanged total is not a change, even with a previous total given", () => {
    const p = payload();
    const view = buildCheckoutView(listing(), p, {
      previousTotalMinor: p.quote.totalMinor,
      previousLines: encodeLines(p.quote),
      idempotencyKey: "k",
    });
    expect(view.change).toBeNull();
    expect(view.lines.some((l) => l.changed)).toBe(false);
  });

  test("without usable previous lines nothing is highlighted, but the change is still reported", () => {
    const p = payload();
    const view = buildCheckoutView(listing(), p, {
      previousTotalMinor: 1,
      previousLines: "garbage",
      idempotencyKey: "k",
    });
    expect(view.change).not.toBeNull();
    expect(view.lines.some((l) => l.changed)).toBe(false);
  });

  test("policy label and text; an unknown or missing policy says nothing is promised", () => {
    expect(
      buildCheckoutView(
        listing({ cancellationPolicy: "strict" }),
        payload(),
        {},
      ).policy,
    ).toEqual({
      value: "strict",
      label: "Strict",
      text: POLICY_TEXT.strict,
    });
    for (const bad of [undefined, "lenient", "__proto__", "constructor"]) {
      const policy = buildCheckoutView(
        listing({ cancellationPolicy: bad }),
        payload(),
        {},
      ).policy;
      expect(policy.text).toBe(NO_POLICY_TEXT);
      expect(policy.value).toBe("");
    }
  });
});

describe("cancellation texts", () => {
  test("there is a text for every policy a host can choose, and no other", () => {
    expect(Object.keys(POLICY_TEXT).sort()).toEqual(
      [...CANCELLATION_POLICY_VALUES].sort(),
    );
    for (const value of CANCELLATION_POLICY_VALUES)
      expect(cancellationText(value)).toBe(POLICY_TEXT[value]);
  });
});

describe("lineLabel", () => {
  test("words for each code; money is formatted from integer paise", () => {
    expect(
      lineLabel({ code: "nights", quantity: 3, unitMinor: 250000 }, "INR"),
    ).toBe("₹2,500 × 3 nights");
    expect(
      lineLabel({ code: "nights", quantity: 1, unitMinor: 250000 }, "INR"),
    ).toBe("₹2,500 × 1 night");
    expect(
      lineLabel(
        { code: "weekend_nights", quantity: 2, unitMinor: 300000 },
        "INR",
      ),
    ).toBe("₹3,000 × 2 weekend nights");
    expect(lineLabel({ code: "cleaning" })).toBe("Cleaning fee");
    expect(lineLabel({ code: "service_fee" })).toBe("Service fee");
    expect(lineLabel({ code: "tax" })).toBe("Taxes");
    expect(lineLabel({ code: "tax", included: true })).toBe(
      "Taxes (included in the price)",
    );
    expect(lineLabel({ code: "something_new" })).toBe("Other charges");
  });
});

describe("encodeLines / decodeLines", () => {
  test("round trip", () => {
    const quote = {
      lines: [
        { code: "nights", amountMinor: 750000 },
        { code: "tax", amountMinor: 1200 },
      ],
    };
    expect(encodeLines(quote)).toBe("nights:750000;tax:1200");
    expect([...decodeLines("nights:750000;tax:1200")]).toEqual([
      ["nights", 750000],
      ["tax", 1200],
    ]);
  });

  test("anything that is not in the strict format is ignored", () => {
    expect(decodeLines("x".repeat(500)).size).toBe(0);
    expect(decodeLines(undefined).size).toBe(0);
    expect(decodeLines(["a:1"]).size).toBe(0);
    expect([
      ...decodeLines("nights:1;<script>:2;tax:-5;cleaning:1e9;ok_code:7"),
    ]).toEqual([
      ["nights", 1],
      ["ok_code", 7],
    ]);
  });
});

test("dayLabel formats a date-only value without moving it to another day", () => {
  expect(dayLabel("2026-12-31")).toMatch(/^Thu,? 31 Dec,? 2026$/);
  expect(dayLabel("2027-01-01")).toMatch(/^Fri,? 1 Jan,? 2027$/);
});
