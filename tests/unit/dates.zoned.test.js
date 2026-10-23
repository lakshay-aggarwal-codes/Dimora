// P09-T03: the wall-clock helpers behind the refund cut-offs.
const {
  parseDateOnly,
  parseClockTime,
  zonedInstant,
} = require("../../src/utils/dates");

const D = (s) => parseDateOnly(s);
const iso = (d) => d.toISOString();

describe("parseClockTime", () => {
  test("HH:MM to minutes since midnight", () => {
    expect(parseClockTime("00:00")).toBe(0);
    expect(parseClockTime("14:00")).toBe(840);
    expect(parseClockTime("23:59")).toBe(1439);
  });
  test.each([
    "24:00",
    "9:00",
    "14:60",
    "14:00:00",
    " 14:00",
    "",
    "noon",
    null,
    undefined,
    1400,
    ["14:00"],
  ])("%p is not a time", (value) => {
    expect(parseClockTime(value)).toBeNull();
  });
});

describe("zonedInstant", () => {
  test("a zone without daylight saving", () => {
    expect(iso(zonedInstant(D("2026-12-01"), 840, "Asia/Kolkata"))).toBe(
      "2026-12-01T08:30:00.000Z",
    );
    expect(iso(zonedInstant(D("2026-12-01"), 0, "Asia/Kolkata"))).toBe(
      "2026-11-30T18:30:00.000Z",
    );
    expect(iso(zonedInstant(D("2026-12-01"), 0, "UTC"))).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  test("extreme offsets: UTC+14 and UTC-12 put the same wall clock a day apart", () => {
    expect(iso(zonedInstant(D("2026-12-01"), 0, "Pacific/Kiritimati"))).toBe(
      "2026-11-30T10:00:00.000Z",
    );
    expect(iso(zonedInstant(D("2026-12-01"), 0, "Etc/GMT+12"))).toBe(
      "2026-12-01T12:00:00.000Z",
    );
  });

  test("daylight saving: the same 14:00 is a different instant in summer and winter", () => {
    expect(iso(zonedInstant(D("2026-07-01"), 840, "America/New_York"))).toBe(
      "2026-07-01T18:00:00.000Z",
    );
    expect(iso(zonedInstant(D("2026-12-01"), 840, "America/New_York"))).toBe(
      "2026-12-01T19:00:00.000Z",
    );
  });

  test("on the day clocks go forward (2026-03-08) and back (2026-11-01)", () => {
    // 14:00 is after the change on both days
    expect(iso(zonedInstant(D("2026-03-08"), 840, "America/New_York"))).toBe(
      "2026-03-08T18:00:00.000Z",
    );
    expect(iso(zonedInstant(D("2026-11-01"), 840, "America/New_York"))).toBe(
      "2026-11-01T19:00:00.000Z",
    );
    // midnight is before the change on both days
    expect(iso(zonedInstant(D("2026-03-08"), 0, "America/New_York"))).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(iso(zonedInstant(D("2026-11-01"), 0, "America/New_York"))).toBe(
      "2026-11-01T04:00:00.000Z",
    );
  });

  test("a repeated hour (01:30 on 2026-11-01) is its first occurrence", () => {
    expect(iso(zonedInstant(D("2026-11-01"), 90, "America/New_York"))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  test("the day after a change is exactly 24 hours of wall clock, not of elapsed time", () => {
    const before = zonedInstant(D("2026-03-07"), 840, "America/New_York");
    const after = zonedInstant(D("2026-03-08"), 840, "America/New_York");
    expect(after.getTime() - before.getTime()).toBe(23 * 3600000); // the short day
  });

  test("bad input is refused", () => {
    expect(() => zonedInstant(D("2026-12-01"), 840, "Mars/Olympus")).toThrow(
      /time zone/i,
    );
    expect(() => zonedInstant(D("2026-12-01"), 1440, "UTC")).toThrow(TypeError);
    expect(() => zonedInstant(D("2026-12-01"), -1, "UTC")).toThrow(TypeError);
    expect(() => zonedInstant(D("2026-12-01"), 1.5, "UTC")).toThrow(TypeError);
    expect(() =>
      zonedInstant(new Date("2026-12-01T10:00:00Z"), 0, "UTC"),
    ).toThrow();
  });
});
