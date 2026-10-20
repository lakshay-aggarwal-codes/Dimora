// Month helpers added to src/utils/dates.js for the availability calendar
// (P07-T03). All UTC, so no time zone can move a date.
const {
  parseDateOnly,
  parseMonthKey,
  formatMonthKey,
  startOfMonth,
  addMonths,
  daysInMonth,
  isoWeekday,
} = require("../../src/utils/dates");

const d = (s) => parseDateOnly(s);

describe("parseMonthKey", () => {
  test("a valid YYYY-MM is the first day of that month", () => {
    expect(parseMonthKey("2026-11").toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(parseMonthKey("2028-02").toISOString()).toBe(
      "2028-02-01T00:00:00.000Z",
    );
  });

  test.each([
    "2026-13",
    "2026-00",
    "2026-1",
    "26-11",
    "2026-11-05",
    "2026-11 ",
    " 2026-11",
    "2026/11",
    "0999-01",
    "",
    "abc",
  ])("%j is refused", (value) => {
    expect(parseMonthKey(value)).toBeNull();
  });

  test("anything that is not a string is refused", () => {
    for (const value of [undefined, null, 202611, ["2026-11"], { a: 1 }]) {
      expect(parseMonthKey(value)).toBeNull();
    }
  });
});

describe("formatMonthKey / startOfMonth / addMonths", () => {
  test("format round-trips with parse", () => {
    expect(formatMonthKey(parseMonthKey("2026-07"))).toBe("2026-07");
  });

  test("startOfMonth goes to day 1", () => {
    expect(startOfMonth(d("2026-11-19")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(startOfMonth(d("2026-12-31")).toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  test("addMonths steps across year ends, forwards and backwards", () => {
    expect(formatMonthKey(addMonths(d("2026-11-19"), 1))).toBe("2026-12");
    expect(formatMonthKey(addMonths(d("2026-11-19"), 2))).toBe("2027-01");
    expect(formatMonthKey(addMonths(d("2026-01-31"), -1))).toBe("2025-12");
    expect(formatMonthKey(addMonths(d("2026-10-20"), -12))).toBe("2025-10");
    expect(formatMonthKey(addMonths(d("2026-10-20"), 0))).toBe("2026-10");
  });

  test("January 31 + 1 month is February (no overflow into March)", () => {
    expect(formatMonthKey(addMonths(d("2026-01-31"), 1))).toBe("2026-02");
  });

  test("bad input is a programming error", () => {
    expect(() => addMonths(d("2026-01-01"), 1.5)).toThrow(TypeError);
    expect(() => addMonths(new Date("2026-01-01T05:00:00Z"), 1)).toThrow(
      TypeError,
    );
    expect(() => startOfMonth("2026-01-01")).toThrow(TypeError);
  });
});

describe("daysInMonth", () => {
  test.each([
    ["2026-01-15", 31],
    ["2026-02-01", 28],
    ["2028-02-29", 29], // leap year
    ["2100-02-10", 28], // not a leap year
    ["2026-04-30", 30],
    ["2026-12-31", 31],
  ])("%s -> %i", (date, days) => {
    expect(daysInMonth(d(date))).toBe(days);
  });
});

describe("isoWeekday", () => {
  test("Monday is 0 and Sunday is 6", () => {
    expect(isoWeekday(d("2026-11-02"))).toBe(0); // Monday
    expect(isoWeekday(d("2026-11-03"))).toBe(1);
    expect(isoWeekday(d("2026-11-08"))).toBe(6); // Sunday
    expect(isoWeekday(d("2026-11-01"))).toBe(6); // Sunday
    expect(isoWeekday(d("2026-10-20"))).toBe(1); // Tuesday
  });
});
