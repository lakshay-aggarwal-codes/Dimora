// P08-T04: seasonal prices, weekend markup and long-stay discounts in quote().
// Pure: no database. 2026-11-13 is a Friday.
const { quote } = require("../../src/services/pricing");
const { QuoteRefusedError } = require("../../src/utils/errors");

const day = (s) => new Date(`${s}T00:00:00Z`);
const base = (pricing = {}) => ({
  pricing: { nightlyMinor: 100000, cleaningFeeMinor: 0, currency: "INR", ...pricing },
});
const q = (listing, checkIn, checkOut) => quote({ listing, checkIn, checkOut, guests: 2 });
const codes = (r) => r.lines.map((l) => l.code);
const line = (r, code) => r.lines.find((l) => l.code === code);
const invariant = (r) => {
  const positive = r.lines.filter((l) => !l.included && l.amountMinor >= 0).reduce((n, l) => n + l.amountMinor, 0);
  const negative = r.lines.filter((l) => !l.included && l.amountMinor < 0).reduce((n, l) => n + l.amountMinor, 0);
  expect(r.totalMinor).toBe(positive + negative);
};

describe("no rules: nothing changes", () => {
  test("empty or absent rules give the same quote as before", () => {
    const plain = q(base(), "2026-11-12", "2026-11-16");
    const empty = q(base({ seasonalRates: [], discounts: {}, weekendBps: null }), "2026-11-12", "2026-11-16");
    expect(empty).toEqual(plain);
    expect(codes(plain)).toEqual(["nights", "weekend_nights", "service_fee", "tax"]);
    expect(plain.discountMinor).toBeUndefined();
  });
});

describe("weekend markup", () => {
  test("Friday and Saturday nights cost the percentage more, on their own line", () => {
    const r = q(base({ weekendBps: 2000 }), "2026-11-12", "2026-11-16"); // Thu Fri Sat Sun
    expect(line(r, "nights")).toEqual({ code: "nights", quantity: 2, unitMinor: 100000, amountMinor: 200000 });
    expect(line(r, "weekend_nights")).toEqual({ code: "weekend_nights", quantity: 2, unitMinor: 120000, amountMinor: 240000 });
    expect(r.subtotalMinor).toBe(440000);
    invariant(r);
  });

  test("rounds half up to the paisa", () => {
    const r = q(base({ nightlyMinor: 10005, weekendBps: 1000 }), "2026-11-13", "2026-11-14"); // 10005 + 1000.5
    expect(line(r, "weekend_nights").unitMinor).toBe(11006);
  });

  test("the markup wins over an older absolute weekend price", () => {
    const r = q(base({ weekendBps: 1000, weekendNightlyMinor: 500000 }), "2026-11-13", "2026-11-14");
    expect(line(r, "weekend_nights").unitMinor).toBe(110000);
  });

  test("an older absolute weekend price still works when there is no markup", () => {
    const r = q(base({ weekendNightlyMinor: 150000 }), "2026-11-13", "2026-11-14");
    expect(line(r, "weekend_nights").unitMinor).toBe(150000);
  });
});

describe("seasonal prices", () => {
  const diwali = { name: "Diwali", from: day("2026-11-13"), to: day("2026-11-15"), nightlyMinor: 200000 };

  test("nights inside a season use its price, on a line with its name and key", () => {
    const r = q(base({ seasonalRates: [diwali] }), "2026-11-10", "2026-11-17"); // 7 nights; Fri 13, Sat 14, Sun 15 in season
    expect(line(r, "season_nights")).toMatchObject({ quantity: 1, unitMinor: 200000, amountMinor: 200000, key: "season_1_weekday", label: "Diwali" });
    expect(line(r, "season_weekend_nights")).toMatchObject({ quantity: 2, unitMinor: 200000, amountMinor: 400000, key: "season_1_weekend", label: "Diwali" });
    expect(line(r, "nights").quantity).toBe(4);
    expect(r.subtotalMinor).toBe(4 * 100000 + 200000 + 400000);
    invariant(r);
  });

  test("both ends of a season are included; the night before and after are not", () => {
    const r = q(base({ seasonalRates: [diwali] }), "2026-11-12", "2026-11-16"); // 12 | 13 14 15 | (16 not charged)
    expect(line(r, "nights").quantity).toBe(1); // Thu 12, before the season
    expect(line(r, "season_weekend_nights").quantity).toBe(2); // Fri 13, Sat 14
    expect(line(r, "season_nights").quantity).toBe(1); // Sun 15, the last day of the season
    expect(r.nights).toBe(4); // the 16th is the check-out day: not charged
  });

  test("a weekend night in a season takes the markup on the season's price", () => {
    const r = q(base({ seasonalRates: [diwali], weekendBps: 2000 }), "2026-11-13", "2026-11-15"); // Fri, Sat
    expect(line(r, "season_weekend_nights")).toMatchObject({ quantity: 2, unitMinor: 240000, amountMinor: 480000, key: "season_1_weekend" });
    expect(line(r, "weekend_nights")).toBeUndefined();
  });

  test("without a markup, a weekend night in a season costs the season's price (not the older weekend price)", () => {
    const r = q(base({ seasonalRates: [diwali], weekendNightlyMinor: 150000 }), "2026-11-13", "2026-11-14");
    expect(line(r, "season_weekend_nights").unitMinor).toBe(200000);
  });

  test("two seasons each get their own lines, in date order, whatever order they are stored in", () => {
    const winter = { name: "Winter", from: day("2026-12-20"), to: day("2027-01-05"), nightlyMinor: 300000 };
    const r = q(base({ seasonalRates: [winter, diwali] }), "2026-11-12", "2026-12-23");
    const keys = r.lines.filter((l) => l.key).map((l) => l.key);
    expect(keys[0].startsWith("season_1_")).toBe(true);
    expect(r.lines.find((l) => l.label === "Diwali").key.startsWith("season_1_")).toBe(true);
    expect(r.lines.find((l) => l.label === "Winter").key.startsWith("season_2_")).toBe(true);
    invariant(r);
  });

  test("seasons can be given as YYYY-MM-DD text", () => {
    const r = q(base({ seasonalRates: [{ name: "Text", from: "2026-11-13", to: "2026-11-15", nightlyMinor: 200000 }] }), "2026-11-15", "2026-11-16");
    expect(line(r, "season_nights").unitMinor).toBe(200000);
  });

  test("if stored seasons overlap anyway, the one that starts first wins", () => {
    const a = { name: "A", from: day("2026-11-10"), to: day("2026-11-20"), nightlyMinor: 150000 };
    const b = { name: "B", from: day("2026-11-12"), to: day("2026-11-30"), nightlyMinor: 900000 };
    const r = q(base({ seasonalRates: [b, a] }), "2026-11-16", "2026-11-17");
    expect(line(r, "season_nights")).toMatchObject({ label: "A", unitMinor: 150000 });
  });
});

describe("long-stay discounts", () => {
  const week = ["2026-11-16", "2026-11-23"]; // 7 nights, Mon to Mon
  const cleaned = (extra) => base({ cleaningFeeMinor: 50000, ...extra });

  test("7 nights get the weekly discount, taken from the nights and not from the cleaning fee", () => {
    const r = q(cleaned({ discounts: { weeklyBps: 1000 } }), ...week);
    expect(codes(r)).toEqual(["nights", "weekend_nights", "length_discount", "cleaning", "service_fee", "tax"]);
    expect(line(r, "length_discount")).toEqual({ code: "length_discount", kind: "weekly", rateBps: 1000, baseMinor: 700000, amountMinor: -70000 });
    expect(r.discountMinor).toBe(70000);
    expect(r.subtotalMinor).toBe(700000);
    expect(line(r, "cleaning").amountMinor).toBe(50000);
    expect(line(r, "service_fee").baseMinor).toBe(680000); // 700000 - 70000 + 50000
    expect(r.totalMinor).toBe(870400);
    invariant(r);
  });

  test("6 nights get nothing; 28 nights get the monthly one", () => {
    expect(line(q(cleaned({ discounts: { weeklyBps: 1000 } }), "2026-11-16", "2026-11-22"), "length_discount")).toBeUndefined();
    const m = q(cleaned({ discounts: { weeklyBps: 1000, monthlyBps: 2000 } }), "2026-11-02", "2026-11-30"); // 28 nights
    expect(line(m, "length_discount")).toMatchObject({ kind: "monthly", rateBps: 2000 });
  });

  test("only the larger discount that applies is used, never both", () => {
    const r = q(cleaned({ discounts: { weeklyBps: 1500, monthlyBps: 500 } }), "2026-11-02", "2026-11-30");
    expect(r.lines.filter((l) => l.code === "length_discount")).toHaveLength(1);
    expect(line(r, "length_discount")).toMatchObject({ kind: "weekly", rateBps: 1500 });
    const onlyMonthly = q(cleaned({ discounts: { monthlyBps: 2000 } }), ...week);
    expect(line(onlyMonthly, "length_discount")).toBeUndefined(); // 7 nights, no weekly set
  });

  test("it applies after seasons and weekend markup", () => {
    const r = q(
      base({
        weekendBps: 2000,
        discounts: { weeklyBps: 1000 },
        seasonalRates: [{ name: "Peak", from: day("2026-11-16"), to: day("2026-11-22"), nightlyMinor: 200000 }],
      }),
      ...week,
    );
    // Mon-Thu, Sun at 200000 (5 nights), Fri Sat at 240000 (2 nights)
    expect(r.subtotalMinor).toBe(5 * 200000 + 2 * 240000);
    expect(line(r, "length_discount").amountMinor).toBe(-Math.round((5 * 200000 + 2 * 240000) * 0.1));
    invariant(r);
  });

  test("the average per night is the discounted one", () => {
    const r = q(base({ discounts: { weeklyBps: 1000 } }), ...week);
    expect(r.avgPerNightMinor).toBe(90000);
  });

  test("the discount rounds half up", () => {
    const r = q(base({ nightlyMinor: 10005, discounts: { weeklyBps: 1000 } }), ...week); // 70035 * 10% = 7003.5
    expect(r.discountMinor).toBe(7004);
  });

  test("inclusive tax: still consistent", () => {
    const config = { currency: "INR", serviceFeeBps: 1000, taxMode: "inclusive", taxSlabs: [{ upToMinor: null, rateBps: 1800 }], weekendDays: [5, 6] };
    const r = quote({ listing: base({ discounts: { weeklyBps: 1000 } }), checkIn: week[0], checkOut: week[1], guests: 1 }, { config });
    expect(line(r, "tax").included).toBe(true);
    invariant(r);
  });
});

describe("rules that cannot be read refuse the quote instead of guessing", () => {
  const bad = (pricing) => () => q(base(pricing), "2026-11-16", "2026-11-17");
  test.each([
    ["weekendBps: 1.5", { weekendBps: 1.5 }],
    ["weekendBps: -1", { weekendBps: -1 }],
    ["weekendBps: 10001", { weekendBps: 10001 }],
    ["weeklyBps: 5001", { discounts: { weeklyBps: 5001 } }],
    ["monthlyBps: '10'", { discounts: { monthlyBps: "10" } }],
    ["season without a price", { seasonalRates: [{ name: "x", from: day("2026-11-01"), to: day("2026-11-02") }] }],
    ["season ending before it starts", { seasonalRates: [{ name: "x", from: day("2026-11-05"), to: day("2026-11-02"), nightlyMinor: 1000 }] }],
    ["season price 0", { seasonalRates: [{ name: "x", from: day("2026-11-01"), to: day("2026-11-02"), nightlyMinor: 0 }] }],
    ["season with a bad date", { seasonalRates: [{ name: "x", from: "nope", to: day("2026-11-02"), nightlyMinor: 1000 }] }],
  ])("%s", (_name, pricing) => {
    expect(bad(pricing)).toThrow(QuoteRefusedError);
  });
});
