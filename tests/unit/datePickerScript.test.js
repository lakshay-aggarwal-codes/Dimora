// public/js/date-picker.js: the pure calendar and rule logic, in a Node vm.
// The widget itself needs a browser (see docs/tasks/P07-T04.md for the checks).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "date-picker.js"),
  "utf8",
);

function load() {
  const context = { document: { querySelector: () => null } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context.DimoraDatePickerCore;
}

const core = load();
const epochDay = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000);
const set = (...days) => new Set(days);

describe("calendar arithmetic", () => {
  test("daysFromCivil / civilFromDays agree with Date.UTC for 1990-2100", () => {
    for (let day = epochDay(1990, 1, 1); day <= epochDay(2100, 12, 31); day += 1) {
      const date = new Date(day * 86400000);
      const civil = core.civilFromDays(day);
      expect(civil).toEqual({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      });
      expect(core.daysFromCivil(civil.year, civil.month, civil.day)).toBe(day);
      expect(core.weekday(day)).toBe(date.getUTCDay());
    }
  });

  test("parse is strict and format round-trips", () => {
    expect(core.parse("2026-02-28")).toBe(epochDay(2026, 2, 28));
    expect(core.parse("2028-02-29")).toBe(epochDay(2028, 2, 29)); // leap day
    for (const bad of ["2026-02-30", "2026-1-5", "2026-13-01", "2026-00-10", "2026-01-00",
      "2026-01-05T00:00:00Z", " 2026-01-05", "2026-01-05\n", "0999-01-01", "", null, undefined, 20260105]) {
      expect(core.parse(bad)).toBeNull();
    }
    expect(core.parse("2026-02-29")).toBeNull(); // 2026 is not a leap year
    expect(core.format(core.parse("2026-11-09"))).toBe("2026-11-09");
  });

  test("monthGrid lays out whole weeks starting on Sunday", () => {
    const weeks = core.monthGrid(2026, 11); // 1 November 2026 is a Sunday
    expect(weeks[0][0]).toBe(epochDay(2026, 11, 1));
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    const days = weeks.flat().filter((d) => d !== null);
    expect(days).toHaveLength(30);
    const feb = core.monthGrid(2028, 2).flat().filter((d) => d !== null);
    expect(feb).toHaveLength(29);
  });
});

describe("stay rules", () => {
  const today = epochDay(2026, 10, 20);
  const rules = { today, latestCheckIn: today + 365, minNights: 2, maxNights: 5 };

  test("checkOutBounds allows check-out on the first taken night, not beyond", () => {
    const taken = set(today + 13);
    expect(core.checkOutBounds(today + 10, rules, taken)).toEqual({ min: today + 12, max: today + 13 });
    expect(core.checkOutBounds(today + 10, rules, set())).toEqual({ min: today + 12, max: today + 15 });
  });

  test("a check-in with no room for the minimum stay has no bounds", () => {
    expect(core.checkOutBounds(today + 10, rules, set(today + 11))).toBeNull();
  });

  test("canCheckIn: past, too far ahead, taken and too-short gaps are refused", () => {
    expect(core.canCheckIn(today, rules, set())).toBe(true);
    expect(core.canCheckIn(today - 1, rules, set())).toBe(false);
    expect(core.canCheckIn(today + 366, rules, set())).toBe(false);
    expect(core.canCheckIn(today + 5, rules, set(today + 5))).toBe(false);
    expect(core.canCheckIn(today + 5, rules, set(today + 6))).toBe(false);
    expect(core.canCheckIn(today + 5, rules, set(today + 7))).toBe(true);
  });

  test("problemWith mirrors the server messages", () => {
    expect(core.problemWith(today + 3, today + 6, rules, set())).toBe("");
    expect(core.problemWith(today + 3, today + 3, rules, set())).toMatch(/after check-in/);
    expect(core.problemWith(today - 1, today + 2, rules, set())).toMatch(/past/);
    expect(core.problemWith(today + 3, today + 4, rules, set())).toMatch(/minimum stay is 2 nights/);
    expect(core.problemWith(today + 3, today + 9, rules, set())).toMatch(/maximum stay is 5 nights/);
    expect(core.problemWith(today + 3, today + 6, rules, set(today + 4))).toMatch(/not available/);
    // the check-out day itself may be taken
    expect(core.problemWith(today + 3, today + 6, rules, set(today + 6))).toBe("");
  });

  test("every bound agrees with problemWith (property loop)", () => {
    const taken = set(today + 4, today + 9, today + 10, today + 20);
    for (let checkIn = today; checkIn < today + 30; checkIn += 1) {
      const bounds = core.checkOutBounds(checkIn, rules, taken);
      for (let out = checkIn + 1; out <= checkIn + 8; out += 1) {
        const fine = core.problemWith(checkIn, out, rules, taken) === "";
        const inside = Boolean(bounds) && out >= bounds.min && out <= bounds.max;
        if (!taken.has(checkIn)) expect(fine).toBe(inside);
      }
    }
  });
});

describe("script hygiene", () => {
  test("does nothing without a picker on the page", () => {
    expect(() => load()).not.toThrow();
  });

  test("never builds HTML from strings or a Date from a string", () => {
    expect(SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(SOURCE).not.toMatch(/new\s+Date\(|Date\.parse\(/);
  });
});
