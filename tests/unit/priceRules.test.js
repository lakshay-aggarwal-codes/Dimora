// P08-T04: the seasonal-price boxes of the pricing form (pure, no database).
const { parseSeasons, seasonFormValues, SEASON_FIELD_NAMES, MAX_SEASONS } = require("../../src/utils/priceRules");
const { hostReceivableMinor } = require("../../src/services/hostOverview");

const row = (n, name, from, to, price) => ({
  [`season${n}Name`]: name,
  [`season${n}From`]: from,
  [`season${n}To`]: to,
  [`season${n}Price`]: price,
});
const iso = (d) => d.toISOString().slice(0, 10);

describe("parseSeasons", () => {
  test("a form with no season boxes filled has no seasons and no errors", () => {
    expect(parseSeasons({})).toEqual({ seasons: [], errors: {} });
    expect(parseSeasons(row(1, "", "", "", ""))).toEqual({ seasons: [], errors: {} });
    expect(parseSeasons(undefined)).toEqual({ seasons: [], errors: {} });
  });

  test("a good row becomes the stored shape: date-only Dates, price in paise", () => {
    const { seasons, errors } = parseSeasons(row(1, "  Winter ", "2026-12-20", "2027-01-05", "3500.50"));
    expect(errors).toEqual({});
    expect(seasons).toHaveLength(1);
    expect(seasons[0].name).toBe("Winter");
    expect(iso(seasons[0].from)).toBe("2026-12-20");
    expect(iso(seasons[0].to)).toBe("2027-01-05");
    expect(seasons[0].from.toISOString()).toBe("2026-12-20T00:00:00.000Z");
    expect(seasons[0].nightlyMinor).toBe(350050);
  });

  test("rows come out sorted by start date whatever row they were typed in", () => {
    const body = { ...row(1, "B", "2027-02-01", "2027-02-10", "2000"), ...row(3, "A", "2026-12-01", "2026-12-10", "3000") };
    expect(parseSeasons(body).seasons.map((s) => s.name)).toEqual(["A", "B"]);
  });

  test("a half-filled row is an error on its first empty box", () => {
    const { errors, seasons } = parseSeasons(row(2, "Summer", "2026-06-01", "", ""));
    expect(Object.keys(errors)).toEqual(["season2To"]);
    expect(errors.season2To).toMatch(/all four boxes/);
    expect(seasons).toEqual([]);
  });

  test("dates must be real YYYY-MM-DD, the end cannot precede the start, 366 days at most", () => {
    expect(Object.keys(parseSeasons(row(1, "x", "2026-02-30", "2026-03-05", "1000")).errors)).toEqual(["season1From"]);
    expect(Object.keys(parseSeasons(row(1, "x", "20/12/2026", "2026-03-05", "1000")).errors)).toEqual(["season1From"]);
    expect(parseSeasons(row(1, "x", "2026-03-05", "2026-03-01", "1000")).errors.season1To).toMatch(/cannot end before/);
    expect(parseSeasons(row(1, "x", "2026-01-01", "2026-12-31", "1000")).errors).toEqual({}); // 365 days
    expect(parseSeasons(row(1, "x", "2026-01-01", "2027-01-02", "1000")).errors.season1To).toMatch(/at most 366/);
  });

  test("the price must be a number from 100 to 1,000,000 rupees", () => {
    for (const price of ["99", "abc", "1000001", "-5", "NaN", "Infinity"]) {
      expect(Object.keys(parseSeasons(row(1, "x", "2026-03-01", "2026-03-05", price)).errors)).toEqual(["season1Price"]);
    }
    expect(parseSeasons(row(1, "x", "2026-03-01", "2026-03-05", "100")).errors).toEqual({});
    expect(parseSeasons(row(1, "x", "2026-03-01", "2026-03-05", "1000000")).errors).toEqual({});
  });

  test("the name is at most 40 characters", () => {
    expect(Object.keys(parseSeasons(row(1, "x".repeat(41), "2026-03-01", "2026-03-05", "1000")).errors)).toEqual(["season1Name"]);
    expect(parseSeasons(row(1, "x".repeat(40), "2026-03-01", "2026-03-05", "1000")).errors).toEqual({});
  });

  test("seasons that share a night are refused, on the later one's start date; touching is fine", () => {
    const overlap = { ...row(1, "A", "2026-12-01", "2026-12-10", "1000"), ...row(2, "B", "2026-12-10", "2026-12-20", "1000") };
    const r = parseSeasons(overlap);
    expect(Object.keys(r.errors)).toEqual(["season2From"]);
    expect(r.errors.season2From).toMatch(/overlaps the season "A"/);
    const touching = { ...row(1, "A", "2026-12-01", "2026-12-10", "1000"), ...row(2, "B", "2026-12-11", "2026-12-20", "1000") };
    expect(parseSeasons(touching).errors).toEqual({});
    const sameDay = { ...row(1, "A", "2026-12-01", "2026-12-01", "1000"), ...row(2, "B", "2026-12-01", "2026-12-01", "1000") };
    expect(Object.keys(parseSeasons(sameDay).errors)).toEqual(["season2From"]);
  });

  test("all five rows can be used", () => {
    let body = {};
    for (let n = 1; n <= MAX_SEASONS; n += 1) body = { ...body, ...row(n, `S${n}`, `2026-0${n}-01`, `2026-0${n}-10`, "1500") };
    const r = parseSeasons(body);
    expect(r.errors).toEqual({});
    expect(r.seasons).toHaveLength(5);
    expect(SEASON_FIELD_NAMES).toHaveLength(20);
  });

  test("non-string values do not break it", () => {
    const r = parseSeasons({ season1Name: ["a"], season1From: { x: 1 }, season1To: 5, season1Price: null });
    expect(Object.keys(r.errors).length).toBeGreaterThan(0);
  });
});

describe("seasonFormValues", () => {
  test("the stored seasons come back as the flat boxes, the rest empty", () => {
    const stored = [{ name: "Winter", from: new Date("2026-12-20T00:00:00Z"), to: new Date("2027-01-05T00:00:00Z"), nightlyMinor: 350050 }];
    const v = seasonFormValues(stored);
    expect(v.season1Name).toBe("Winter");
    expect(v.season1From).toBe("2026-12-20");
    expect(v.season1To).toBe("2027-01-05");
    expect(v.season1Price).toBe(3500.5);
    expect(v.season2Name).toBe("");
    expect(v.season5Price).toBe("");
    expect(Object.keys(v)).toHaveLength(20);
    expect(Object.keys(seasonFormValues(undefined))).toHaveLength(20);
  });

  test("what the form shows parses back to the same seasons", () => {
    const stored = [{ name: "Peak", from: new Date("2026-12-20T00:00:00Z"), to: new Date("2027-01-05T00:00:00Z"), nightlyMinor: 350000 }];
    const again = parseSeasons(seasonFormValues(stored)).seasons;
    expect(again).toEqual(stored);
  });
});

describe("what the host receives with a discount (used by the overview and the report)", () => {
  const snap = (...lines) => ({ lines });
  test("the discount is taken off; fee and tax stay out", () => {
    expect(
      hostReceivableMinor(
        snap(
          { code: "nights", amountMinor: 500000 },
          { code: "weekend_nights", amountMinor: 200000 },
          { code: "length_discount", amountMinor: -70000 },
          { code: "cleaning", amountMinor: 50000 },
          { code: "service_fee", amountMinor: 68000 },
          { code: "tax", amountMinor: 122400 },
        ),
      ),
    ).toBe(680000);
  });

  test("season lines count as the host's", () => {
    expect(hostReceivableMinor(snap({ code: "season_nights", amountMinor: 100 }, { code: "season_weekend_nights", amountMinor: 50 }))).toBe(150);
  });

  test("never below zero; unreadable lines are ignored; no discount behaves as before", () => {
    expect(hostReceivableMinor(snap({ code: "nights", amountMinor: 100 }, { code: "length_discount", amountMinor: -500 }))).toBe(0);
    expect(hostReceivableMinor(snap({ code: "nights", amountMinor: 100 }, { code: "length_discount", amountMinor: "x" }, null))).toBe(100);
    expect(hostReceivableMinor(snap({ code: "length_discount", amountMinor: 70000 }))).toBe(0); // a positive "discount" is not one
    expect(hostReceivableMinor(undefined)).toBe(0);
  });
});
