// P08-T01: the pricing service. Pure function: no database, clock or network.
const golden = require("../fixtures/pricing-golden.json");
const { quote, BREAKDOWN_VERSION, assertConfig } = require("../../src/services/pricing");
const defaultConfig = require("../../src/config/pricing");
const { ValidationError, QuoteRefusedError } = require("../../src/utils/errors");
const { parseDateOnly } = require("../../src/utils/dates");

const listingFor = ({ nightly, weekend, cleaning }) => ({
  pricing: {
    nightlyMinor: nightly,
    ...(weekend !== undefined ? { weekendNightlyMinor: weekend } : {}),
    ...(cleaning !== undefined ? { cleaningFeeMinor: cleaning } : {}),
    currency: "INR",
  },
});

const configFor = (input) => ({
  ...defaultConfig,
  ...(input.serviceFeeBps !== undefined ? { serviceFeeBps: input.serviceFeeBps } : {}),
  ...(input.taxMode ? { taxMode: input.taxMode } : {}),
  ...(input.taxSlabs ? { taxSlabs: input.taxSlabs } : {}),
  ...(input.weekendDays ? { weekendDays: input.weekendDays } : {}),
});

const run = (input) =>
  quote(
    { listing: listingFor(input), checkIn: input.checkIn, checkOut: input.checkOut, guests: 2 },
    { config: configFor(input) },
  );

const BASE = { nightly: 250000, checkIn: "2026-11-10", checkOut: "2026-11-12" };
const ok = (extra = {}, listingExtra = {}) =>
  quote(
    { listing: { pricing: { nightlyMinor: 250000, currency: "INR", ...listingExtra } }, checkIn: BASE.checkIn, checkOut: BASE.checkOut, guests: 2, ...extra },
  );

describe("golden table (30 cases, computed independently with exact fractions)", () => {
  test("the table has 30 cases", () => {
    expect(golden).toHaveLength(30);
  });

  test.each(golden.map((c) => [c.name, c]))("%s", (_name, c) => {
    const result = run(c.input);
    const e = c.expected;
    expect({
      nights: result.nights,
      subtotalMinor: result.subtotalMinor,
      cleaningMinor: result.cleaningMinor,
      serviceFeeMinor: result.serviceFeeMinor,
      taxMinor: result.taxMinor,
      totalMinor: result.totalMinor,
      avgPerNightMinor: result.avgPerNightMinor,
      lineCodes: result.lines.map((l) => l.code),
    }).toEqual(e);
  });
});

describe("invariants over many random quotes (seeded)", () => {
  // A small seeded generator, so a failure can be reproduced exactly.
  let seed = 123456789;
  const rand = (n) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed % n;
  };

  test("the lines add up to the total, everything is an integer, nothing is negative", () => {
    for (let i = 0; i < 600; i += 1) {
      const nightly = 1 + rand(5000000);
      const nights = 1 + rand(90);
      const checkIn = new Date(Date.UTC(2026, 0, 1 + rand(400)));
      const input = {
        nightly,
        weekend: rand(3) === 0 ? undefined : 1 + rand(5000000),
        cleaning: rand(3) === 0 ? undefined : rand(300000),
        serviceFeeBps: rand(2500),
        taxMode: rand(2) === 0 ? "exclusive" : "inclusive",
        taxSlabs: [
          { upToMinor: 200000, rateBps: rand(2000) },
          { upToMinor: 1000000, rateBps: rand(2000) },
          { upToMinor: null, rateBps: rand(2000) },
        ],
        weekendDays: [[5, 6], [6, 0], [], [0, 1, 2, 3, 4, 5, 6]][rand(4)],
        checkIn: checkIn.toISOString().slice(0, 10),
        checkOut: new Date(checkIn.getTime() + nights * 86400000).toISOString().slice(0, 10),
      };

      const r = run(input);
      const counted = r.lines.filter((l) => !l.included).reduce((sum, l) => sum + l.amountMinor, 0);
      expect(counted).toBe(r.totalMinor);
      expect(r.nights).toBe(nights);
      for (const value of [r.subtotalMinor, r.cleaningMinor, r.serviceFeeMinor, r.taxMinor, r.totalMinor, r.avgPerNightMinor, r.nights]) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value >= 0).toBe(true);
      }
      for (const line of r.lines) {
        expect(Number.isSafeInteger(line.amountMinor)).toBe(true);
        expect(line.amountMinor).toBeGreaterThan(0);
      }
      expect(r.totalMinor).toBeGreaterThanOrEqual(r.subtotalMinor);
      const stay = r.lines.filter((l) => l.code === "nights" || l.code === "weekend_nights");
      expect(stay.reduce((s, l) => s + l.quantity, 0)).toBe(nights);
      expect(stay.reduce((s, l) => s + l.quantity * l.unitMinor, 0)).toBe(r.subtotalMinor);
      expect(Math.abs(r.avgPerNightMinor * nights - r.subtotalMinor)).toBeLessThanOrEqual(nights / 2);
      expect(r.taxIncluded).toBe(input.taxMode === "inclusive");
    }
  });

  test("a longer stay never costs less than a shorter one at the same prices", () => {
    for (let i = 0; i < 100; i += 1) {
      const nightly = 1 + rand(900000);
      const short = 1 + rand(40);
      const a = run({ nightly, cleaning: rand(50000), checkIn: "2026-11-02", checkOut: new Date(Date.UTC(2026, 10, 2 + short)).toISOString().slice(0, 10) });
      const b = run({ nightly, cleaning: a.cleaningMinor, checkIn: "2026-11-02", checkOut: new Date(Date.UTC(2026, 10, 2 + short + 1)).toISOString().slice(0, 10) });
      expect(b.totalMinor).toBeGreaterThanOrEqual(a.totalMinor);
    }
  });
});

describe("the shape of a quote", () => {
  test("exclusive tax: lines in display order with their numbers", () => {
    const r = quote({
      listing: listingFor({ nightly: 250000, weekend: 300000, cleaning: 50000 }),
      checkIn: "2026-11-12",
      checkOut: "2026-11-16",
      guests: 2,
    });
    expect(r.lines).toEqual([
      { code: "nights", quantity: 2, unitMinor: 250000, amountMinor: 500000 },
      { code: "weekend_nights", quantity: 2, unitMinor: 300000, amountMinor: 600000 },
      { code: "cleaning", amountMinor: 50000 },
      { code: "service_fee", rateBps: 1000, baseMinor: 1150000, amountMinor: 115000 },
      { code: "tax", rateBps: 1800, baseMinor: 1150000, amountMinor: 207000 },
    ]);
    expect(r).toMatchObject({
      nights: 4,
      subtotalMinor: 1100000,
      cleaningMinor: 50000,
      serviceFeeMinor: 115000,
      taxMinor: 207000,
      totalMinor: 1472000,
      avgPerNightMinor: 275000,
      currency: "INR",
      taxMode: "exclusive",
      taxIncluded: false,
      breakdownVersion: BREAKDOWN_VERSION,
    });
    expect(BREAKDOWN_VERSION).toBe(1);
  });

  test("inclusive tax: the tax line is shown but marked included, and not added", () => {
    const r = quote(
      { listing: listingFor({ nightly: 118000, cleaning: 11800 }), checkIn: "2026-11-10", checkOut: "2026-11-12", guests: 1 },
      { config: { ...defaultConfig, taxMode: "inclusive", serviceFeeBps: 0 } },
    );
    const tax = r.lines.find((l) => l.code === "tax");
    expect(tax.included).toBe(true);
    expect(r.taxIncluded).toBe(true);
    expect(r.totalMinor).toBe(247800); // 2 x 118000 + 11800, tax already inside
    expect(r.taxMinor).toBe(37800); // 247800 - 247800 / 1.18
  });

  test("a zero cleaning fee, a zero service fee and a zero tax add no lines", () => {
    const r = quote(
      { listing: listingFor({ nightly: 100000 }), checkIn: "2026-11-10", checkOut: "2026-11-11", guests: 1 },
      { config: { ...defaultConfig, serviceFeeBps: 0, taxSlabs: [{ upToMinor: null, rateBps: 0 }] } },
    );
    expect(r.lines.map((l) => l.code)).toEqual(["nights"]);
    expect(r.totalMinor).toBe(100000);
  });

  test("works with a Mongoose-style document (reads through get)", () => {
    const values = { "pricing.nightlyMinor": 100000, "pricing.currency": "INR" };
    const doc = { get: (path) => values[path] };
    expect(quote({ listing: doc, checkIn: "2026-11-10", checkOut: "2026-11-11", guests: 1 }).subtotalMinor).toBe(100000);
  });

  test("accepts date-only Dates as well as strings", () => {
    const a = ok();
    const b = quote({
      listing: { pricing: { nightlyMinor: 250000 } },
      checkIn: parseDateOnly("2026-11-10"),
      checkOut: parseDateOnly("2026-11-12"),
      guests: 2,
    });
    expect(b.totalMinor).toBe(a.totalMinor);
  });

  test("a missing currency means the configured one", () => {
    expect(quote({ listing: { pricing: { nightlyMinor: 100000 } }, checkIn: "2026-11-10", checkOut: "2026-11-11", guests: 1 }).currency).toBe("INR");
  });

  test("tax slabs: the first slab whose limit is at least the average applies", () => {
    const config = { ...defaultConfig, serviceFeeBps: 0, taxSlabs: [{ upToMinor: 100000, rateBps: 500 }, { upToMinor: null, rateBps: 2000 }] };
    const at = (nightly) => quote({ listing: listingFor({ nightly }), checkIn: "2026-11-10", checkOut: "2026-11-11", guests: 1 }, { config });
    expect(at(100000).lines.find((l) => l.code === "tax").rateBps).toBe(500);
    expect(at(100001).lines.find((l) => l.code === "tax").rateBps).toBe(2000);
  });

  test("the default config is the illustrative flat 18 % plus a 10 % service fee", () => {
    expect(defaultConfig).toMatchObject({ currency: "INR", serviceFeeBps: 1000, taxMode: "exclusive" });
    expect(defaultConfig.taxSlabs).toEqual([{ upToMinor: null, rateBps: 1800 }]);
    expect(defaultConfig.weekendDays).toEqual([5, 6]);
    expect(Object.isFrozen(defaultConfig)).toBe(true);
  });
});

describe("refusing a quote", () => {
  const refused = (listing, message) => {
    expect(() => quote({ listing, checkIn: "2026-11-10", checkOut: "2026-11-12", guests: 2 })).toThrow(QuoteRefusedError);
    if (message) expect(() => quote({ listing, checkIn: "2026-11-10", checkOut: "2026-11-12", guests: 2 })).toThrow(message);
  };

  test("no price, zero, negative, fractional, text or huge prices", () => {
    for (const nightly of [undefined, null, 0, -1, 2500.5, "2500", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      refused({ pricing: { nightlyMinor: nightly } }, /valid nightly price/);
    }
    refused({}, /valid nightly price/);
    refused(null, /valid nightly price/);
    refused(undefined, /valid nightly price/);
    refused("a listing", /valid nightly price/);
  });

  test("a weekend price that is set must be valid too", () => {
    for (const weekend of [0, -5, 1.5, "300", NaN]) {
      refused({ pricing: { nightlyMinor: 250000, weekendNightlyMinor: weekend } }, /valid nightly price/);
    }
    expect(ok({}, { weekendNightlyMinor: null }).totalMinor).toBe(ok().totalMinor); // null = not set
  });

  test("a cleaning fee that is set must be a whole, non-negative amount (0 is fine)", () => {
    for (const cleaning of [-1, 1.5, "50", NaN]) {
      refused({ pricing: { nightlyMinor: 250000, cleaningFeeMinor: cleaning } }, /invalid cleaning fee/);
    }
    expect(ok({}, { cleaningFeeMinor: 0 }).cleaningMinor).toBe(0);
    expect(ok({}, { cleaningFeeMinor: null }).cleaningMinor).toBe(0);
  });

  test("a currency other than the configured one is refused", () => {
    refused({ pricing: { nightlyMinor: 250000, currency: "USD" } }, /currency is not supported/);
  });

  test("it is a 422 with a stable code and a message meant for the guest", () => {
    try {
      quote({ listing: {}, checkIn: "2026-11-10", checkOut: "2026-11-12", guests: 1 });
    } catch (err) {
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe("quote_refused");
    }
    expect(new QuoteRefusedError().message).toMatch(/cannot be priced/);
  });
});

describe("bad input", () => {
  const input = (extra) => ({ listing: { pricing: { nightlyMinor: 250000 } }, checkIn: "2026-11-10", checkOut: "2026-11-12", guests: 2, ...extra });

  test("guests must be a whole number of at least 1 (no floats, no text)", () => {
    for (const guests of [0, -1, 1.5, "2", NaN, null, undefined, Infinity]) {
      expect(() => quote(input({ guests }))).toThrow(ValidationError);
    }
    expect(() => quote(input({ guests: 0 }))).toThrow(/Guests must be a whole number/);
    expect(quote(input({ guests: 16 })).nights).toBe(2);
  });

  test("bad or reversed dates are validation errors", () => {
    expect(() => quote(input({ checkIn: "10/11/2026" }))).toThrow(ValidationError);
    expect(() => quote(input({ checkOut: "2026-02-30" }))).toThrow(/Check-out must be a valid date/);
    expect(() => quote(input({ checkIn: "2026-11-12", checkOut: "2026-11-12" }))).toThrow(/after check-in/);
    expect(() => quote(input({ checkIn: "2026-11-14", checkOut: "2026-11-12" }))).toThrow(/after check-in/);
  });

  test("a date that is not a date-only Date is a programming error", () => {
    expect(() => quote(input({ checkIn: new Date("2026-11-10T05:00:00Z"), checkOut: parseDateOnly("2026-11-12") }))).toThrow(TypeError);
    expect(() => quote(input({ checkIn: undefined }))).toThrow(TypeError);
    expect(() => quote(input({ checkIn: 5 }))).toThrow(TypeError);
  });

  test("a stay of 91 nights is refused; 90 is fine", () => {
    expect(() => quote(input({ checkIn: "2027-01-04", checkOut: "2027-04-05" }))).toThrow(/at most 90 nights/);
    expect(quote(input({ checkIn: "2027-01-04", checkOut: "2027-04-04" })).nights).toBe(90);
  });

  test("no arguments at all fails cleanly", () => {
    expect(() => quote()).toThrow(TypeError);
    expect(() => quote({})).toThrow(TypeError);
  });

  test("an amount too large to add up safely is refused, not wrapped", () => {
    const huge = Math.floor(Number.MAX_SAFE_INTEGER / 50);
    expect(() => ok({ checkIn: "2027-01-04", checkOut: "2027-04-04" }, { nightlyMinor: huge })).toThrow(RangeError);
  });
});

describe("the configuration is checked", () => {
  const withConfig = (patch) => () => quote({ listing: { pricing: { nightlyMinor: 100000 } }, checkIn: "2026-11-10", checkOut: "2026-11-11", guests: 1 }, { config: { ...defaultConfig, ...patch } });

  test("the shipped config is valid", () => {
    expect(() => assertConfig(defaultConfig)).not.toThrow();
  });

  test("every kind of mistake is a TypeError naming the problem", () => {
    expect(() => quote({}, { config: null })).toThrow(/missing/);
    expect(withConfig({ currency: "inr" })).toThrow(/currency/);
    for (const serviceFeeBps of [-1, 10001, 1.5, "1000"]) expect(withConfig({ serviceFeeBps })).toThrow(/serviceFeeBps/);
    expect(withConfig({ taxMode: "magic" })).toThrow(/taxMode/);
    expect(withConfig({ taxSlabs: [] })).toThrow(/taxSlabs/);
    expect(withConfig({ taxSlabs: "x" })).toThrow(/taxSlabs/);
    expect(withConfig({ taxSlabs: [{ upToMinor: null, rateBps: 1.5 }] })).toThrow(/rateBps/);
    expect(withConfig({ taxSlabs: [{ upToMinor: null, rateBps: 10001 }] })).toThrow(/rateBps/);
    expect(withConfig({ taxSlabs: [{ upToMinor: null, rateBps: 100 }, { upToMinor: null, rateBps: 200 }] })).toThrow(/only the last slab/);
    expect(withConfig({ taxSlabs: [{ upToMinor: 100, rateBps: 100 }] })).toThrow(/last slab must have/);
    expect(withConfig({ taxSlabs: [{ upToMinor: 200, rateBps: 100 }, { upToMinor: 100, rateBps: 100 }, { upToMinor: null, rateBps: 200 }] })).toThrow(/increasing/);
    expect(withConfig({ taxSlabs: [{ upToMinor: -5, rateBps: 100 }, { upToMinor: null, rateBps: 200 }] })).toThrow(/increasing/);
    expect(withConfig({ weekendDays: "5,6" })).toThrow(/weekendDays/);
    expect(withConfig({ weekendDays: [7] })).toThrow(/weekendDays/);
    expect(withConfig({ weekendDays: [1.5] })).toThrow(/weekendDays/);
  });

  test("a bad config is refused before anything else (even with bad dates)", () => {
    expect(() => quote({ listing: {}, checkIn: "x", checkOut: "y", guests: 0 }, { config: { ...defaultConfig, taxMode: "magic" } })).toThrow(TypeError);
  });
});

describe("it really is pure", () => {
  test("the same input gives the same answer, and the input is not changed", () => {
    const listing = listingFor({ nightly: 250000, weekend: 300000, cleaning: 50000 });
    const before = JSON.stringify(listing);
    const a = quote({ listing, checkIn: "2026-11-12", checkOut: "2026-11-16", guests: 2 });
    const b = quote({ listing, checkIn: "2026-11-12", checkOut: "2026-11-16", guests: 2 });
    expect(a).toEqual(b);
    expect(JSON.stringify(listing)).toBe(before);
  });

  test("the service source has no database, clock, network or float rounding", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/services/pricing"), "utf8");
    for (const forbidden of [/require\(["'][^"']*models/, /mongoose/, /new Date\(\)/, /Date\.now/, /Math\.(round|floor|ceil|trunc)/, /fetch\(/, /require\(["']https?["']\)/, /parseFloat|toFixed/]) {
      expect(forbidden.test(source)).toBe(false);
    }
  });
});
