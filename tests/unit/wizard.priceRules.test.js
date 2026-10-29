// P08-T04: the price-rule fields in wizard step 5, and the Listing model's own
// checks of them (no database).
const { validateStep } = require("../../src/validation/wizard");
const Listing = require("../../src/models/listing");

const body = (extra = {}) => ({
  price: "2500",
  cleaningFee: "300",
  minNights: "1",
  maxNights: "30",
  checkInTime: "14:00",
  checkOutTime: "11:00",
  cancellationPolicy: "flexible",
  ...extra,
});
const bad = (extra) => Object.keys(validateStep(5, body(extra)).errors).sort();

describe("step 5 price rules", () => {
  test("a form without them is still valid and means no rules", () => {
    const { value, errors } = validateStep(5, body());
    expect(errors).toEqual({});
    expect([value.weekendPercent, value.weeklyDiscountPercent, value.monthlyDiscountPercent]).toEqual([0, 0, 0]);
    expect(value.seasons).toEqual([]);
  });

  test("blank boxes mean none", () => {
    const { value, errors } = validateStep(5, body({ weekendPercent: "", weeklyDiscountPercent: "", monthlyDiscountPercent: "", season1Name: "" }));
    expect(errors).toEqual({});
    expect(value.weekendPercent).toBe(0);
  });

  test("weekend increase 0 to 100, whole numbers", () => {
    expect(bad({ weekendPercent: "100" })).toEqual([]);
    expect(bad({ weekendPercent: "101" })).toEqual(["weekendPercent"]);
    expect(bad({ weekendPercent: "-1" })).toEqual(["weekendPercent"]);
    expect(bad({ weekendPercent: "12.5" })).toEqual(["weekendPercent"]);
    expect(bad({ weekendPercent: "abc" })).toEqual(["weekendPercent"]);
  });

  test("discounts 0 to 50, whole numbers", () => {
    expect(bad({ weeklyDiscountPercent: "50", monthlyDiscountPercent: "50" })).toEqual([]);
    expect(bad({ weeklyDiscountPercent: "51" })).toEqual(["weeklyDiscountPercent"]);
    expect(bad({ monthlyDiscountPercent: "-3" })).toEqual(["monthlyDiscountPercent"]);
    expect(bad({ monthlyDiscountPercent: "2.5" })).toEqual(["monthlyDiscountPercent"]);
  });

  test("seasons arrive as an array in value.seasons and the flat boxes are removed", () => {
    const { value, errors } = validateStep(5, body({ season1Name: "Winter", season1From: "2026-12-20", season1To: "2027-01-05", season1Price: "4000" }));
    expect(errors).toEqual({});
    expect(value.seasons).toHaveLength(1);
    expect(value.seasons[0].nightlyMinor).toBe(400000);
    expect(Object.keys(value).some((k) => /^season\d/.test(k))).toBe(false);
  });

  test("a bad season is reported on its own box", () => {
    expect(bad({ season2Name: "x", season2From: "2026-12-20", season2To: "2026-12-01", season2Price: "4000" })).toEqual(["season2To"]);
    expect(bad({ season1Name: "x", season1From: "2026-12-20" })).toEqual(["season1To"]);
  });

  test("season errors are shown together with the other errors of the form", () => {
    expect(bad({ price: "5", season1Name: "x", season1From: "nope", season1To: "2026-12-01", season1Price: "4000" })).toEqual(["price", "season1From"]);
  });

  test("overlapping seasons are refused", () => {
    const errors = validateStep(
      5,
      body({
        season1Name: "A", season1From: "2026-12-01", season1To: "2026-12-10", season1Price: "3000",
        season2Name: "B", season2From: "2026-12-05", season2To: "2026-12-15", season2Price: "3000",
      }),
    ).errors;
    expect(Object.keys(errors)).toEqual(["season2From"]);
  });

  test("an unknown field is still refused", () => {
    expect(bad({ season6Name: "x" })).toEqual(["season6Name"]);
    expect(bad({ weekendBps: "2000" })).toEqual(["weekendBps"]); // the stored form is not accepted from a browser
  });
});

describe("the Listing model's own checks", () => {
  const season = (name, from, to, nightlyMinor = 200000) => ({ name, from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T00:00:00Z`), nightlyMinor });
  const check = (pricing) => new Listing({ pricing: { nightlyMinor: 100000, ...pricing } }).validateSync();
  const messages = (e) => Object.values((e && e.errors) || {}).map((x) => x.message);

  test("good rules pass", () => {
    expect(check({ weekendBps: 2000, discounts: { weeklyBps: 1000, monthlyBps: 2000 }, seasonalRates: [season("A", "2026-12-01", "2026-12-10")] })).toBeUndefined();
  });

  test("weekend markup and discounts must be whole basis points in range", () => {
    expect(messages(check({ weekendBps: 10001 })).join(" ")).toMatch(/Weekend markup/);
    expect(messages(check({ weekendBps: 12.5 })).join(" ")).toMatch(/Weekend markup/);
    expect(check({ discounts: { weeklyBps: 5001 } })).toBeDefined();
    expect(check({ discounts: { monthlyBps: -1 } })).toBeDefined();
    expect(check({ discounts: { weeklyBps: 10.5 } })).toBeDefined();
  });

  test("at most 5 seasons, none ending before it starts, none overlapping", () => {
    const six = Array.from({ length: 6 }, (_, i) => season(`S${i}`, `2026-0${i + 1}-01`, `2026-0${i + 1}-05`));
    expect(messages(check({ seasonalRates: six })).join(" ")).toMatch(/at most 5/);
    expect(messages(check({ seasonalRates: [season("A", "2026-12-10", "2026-12-01")] })).join(" ")).toMatch(/cannot end before/);
    expect(messages(check({ seasonalRates: [season("A", "2026-12-01", "2026-12-10"), season("B", "2026-12-10", "2026-12-12")] })).join(" ")).toMatch(/cannot overlap/);
    expect(check({ seasonalRates: [season("A", "2026-12-01", "2026-12-10"), season("B", "2026-12-11", "2026-12-12")] })).toBeUndefined();
  });

  test("a season needs a name and a price of at least the minimum nightly price", () => {
    expect(check({ seasonalRates: [{ from: new Date("2026-12-01T00:00:00Z"), to: new Date("2026-12-02T00:00:00Z"), nightlyMinor: 200000 }] })).toBeDefined();
    expect(check({ seasonalRates: [season("A", "2026-12-01", "2026-12-02", 50)] })).toBeDefined();
  });
});
