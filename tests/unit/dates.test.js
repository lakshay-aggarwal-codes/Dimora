// P07-T01: calendar-date helpers (ADR-003). Pure functions, no database.
const {
  DEFAULT_TIMEZONE,
  BOOKING_WINDOW,
  isDateOnly,
  tryParseDateOnly,
  parseDateOnly,
  formatDateOnly,
  addDays,
  compareDates,
  isBefore,
  isAfter,
  isSameDate,
  nightsBetween,
  eachNight,
  todayIn,
  bookingWindow,
  assertBookableDates,
} = require("../../src/utils/dates");
const { ValidationError } = require("../../src/utils/errors");

const d = (s) => parseDateOnly(s);
const iso = (dates) => dates.map(formatDateOnly);

describe("parseDateOnly / tryParseDateOnly", () => {
  test("parses a valid date to UTC midnight", () => {
    const date = parseDateOnly("2026-10-14");
    expect(date.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(isDateOnly(date)).toBe(true);
  });

  test("rejects impossible dates", () => {
    for (const s of [
      "2026-02-30",
      "2026-02-29",
      "2100-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "2026-01-32",
    ]) {
      expect(tryParseDateOnly(s)).toBe(null);
    }
  });

  test("rejects anything that is not exactly YYYY-MM-DD", () => {
    for (const s of [
      "2026-1-5",
      "2026-01-5",
      "26-01-05",
      "0999-01-01",
      "0050-01-01",
      "2026/01/05",
      "01-05-2026",
      "20260105",
      "2026-01-05T00:00:00Z",
      "2026-01-05T00:00:00",
      "2026-01-05 00:00",
      " 2026-01-05",
      "2026-01-05 ",
      "2026-01-05\n",
      "\n2026-01-05",
      "2026-01-05;",
      "+2026-01-05",
      "\uFF12\uFF10\uFF12\uFF16-01-05",
      "",
      "today",
      "Oct 14 2026",
    ]) {
      expect(tryParseDateOnly(s)).toBe(null);
    }
  });

  test("rejects non-strings", () => {
    for (const v of [
      undefined,
      null,
      20260105,
      new Date(Date.UTC(2026, 0, 5)),
      {},
      [],
      ["2026-01-05"],
      true,
    ]) {
      expect(tryParseDateOnly(v)).toBe(null);
    }
  });

  test("leap days", () => {
    expect(formatDateOnly(d("2024-02-29"))).toBe("2024-02-29");
    expect(formatDateOnly(d("2000-02-29"))).toBe("2000-02-29");
    expect(tryParseDateOnly("1900-02-29")).toBe(null);
  });

  test("parseDateOnly throws a 400 ValidationError naming the field", () => {
    expect(() => parseDateOnly("2026-02-30", "Check-in")).toThrow(
      ValidationError,
    );
    expect(() => parseDateOnly("2026-02-30", "Check-in")).toThrow(
      /Check-in must be a valid date in YYYY-MM-DD format/,
    );
    let status;
    try {
      parseDateOnly("nope");
    } catch (err) {
      status = err.statusCode;
    }
    expect(status).toBe(400);
  });

  test("every day from 1990 to 2050 round-trips and moves by one day", () => {
    let date = d("1990-01-01");
    const end = d("2050-12-31");
    let previous = null;
    let count = 0;
    while (compareDates(date, end) <= 0) {
      const text = formatDateOnly(date);
      expect(text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(formatDateOnly(parseDateOnly(text))).toBe(text);
      if (previous) expect(date.getTime() - previous.getTime()).toBe(86400000);
      previous = date;
      date = addDays(date, 1);
      count += 1;
    }
    expect(count).toBe(22280); // 61 * 365 + 15 leap days
  });
});

describe("isDateOnly / formatDateOnly / addDays", () => {
  test("isDateOnly is false for instants and invalid values", () => {
    expect(isDateOnly(new Date(Date.UTC(2026, 0, 5, 0, 0, 1)))).toBe(false);
    expect(isDateOnly(new Date(Date.UTC(2026, 0, 5, 12)))).toBe(false);
    expect(isDateOnly(new Date(NaN))).toBe(false);
    expect(isDateOnly("2026-01-05")).toBe(false);
    expect(isDateOnly(null)).toBe(false);
  });

  test("helpers refuse non-date-only input (programming error)", () => {
    const instant = new Date(Date.UTC(2026, 0, 5, 12));
    expect(() => formatDateOnly(instant)).toThrow(TypeError);
    expect(() => addDays(instant, 1)).toThrow(TypeError);
    expect(() => addDays(d("2026-01-05"), 1.5)).toThrow(TypeError);
    expect(() => compareDates(instant, d("2026-01-05"))).toThrow(TypeError);
    expect(() => nightsBetween(instant, d("2026-01-09"))).toThrow(TypeError);
  });

  test("addDays crosses month, year and leap boundaries", () => {
    expect(formatDateOnly(addDays(d("2026-01-31"), 1))).toBe("2026-02-01");
    expect(formatDateOnly(addDays(d("2026-12-31"), 1))).toBe("2027-01-01");
    expect(formatDateOnly(addDays(d("2024-02-28"), 1))).toBe("2024-02-29");
    expect(formatDateOnly(addDays(d("2024-02-29"), 1))).toBe("2024-03-01");
    expect(formatDateOnly(addDays(d("2026-03-01"), -1))).toBe("2026-02-28");
    expect(formatDateOnly(addDays(d("2026-03-01"), 0))).toBe("2026-03-01");
  });
});

describe("comparison helpers", () => {
  test("compare, before, after, same", () => {
    const a = d("2026-05-01");
    const b = d("2026-05-02");
    expect(compareDates(a, b)).toBe(-1);
    expect(compareDates(b, a)).toBe(1);
    expect(compareDates(a, d("2026-05-01"))).toBe(0);
    expect(isBefore(a, b)).toBe(true);
    expect(isBefore(b, a)).toBe(false);
    expect(isBefore(a, a)).toBe(false);
    expect(isAfter(b, a)).toBe(true);
    expect(isAfter(a, a)).toBe(false);
    expect(isSameDate(a, d("2026-05-01"))).toBe(true);
    expect(isSameDate(a, b)).toBe(false);
  });
});

describe("nightsBetween / eachNight", () => {
  test("check-out is not an occupied night", () => {
    expect(iso(eachNight(d("2026-10-14"), d("2026-10-17")))).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
    ]);
    expect(nightsBetween(d("2026-10-14"), d("2026-10-15"))).toBe(1);
  });

  test("check-out equal to or before check-in is a validation error", () => {
    expect(() => nightsBetween(d("2026-10-14"), d("2026-10-14"))).toThrow(
      ValidationError,
    );
    expect(() => eachNight(d("2026-10-14"), d("2026-10-13"))).toThrow(
      /Check-out must be after check-in/,
    );
  });

  test("leap day and month/year boundaries", () => {
    expect(iso(eachNight(d("2024-02-28"), d("2024-03-01")))).toEqual([
      "2024-02-28",
      "2024-02-29",
    ]);
    expect(nightsBetween(d("2026-02-28"), d("2026-03-01"))).toBe(1);
    expect(iso(eachNight(d("2026-12-30"), d("2027-01-02")))).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
  });

  test("across DST changes the count is exactly the calendar difference", () => {
    // US spring-forward 2026-03-08 and fall-back 2026-11-01: UTC arithmetic
    // must not gain or lose a night.
    expect(nightsBetween(d("2026-03-07"), d("2026-03-10"))).toBe(3);
    expect(iso(eachNight(d("2026-03-07"), d("2026-03-10")))).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
    expect(nightsBetween(d("2026-10-31"), d("2026-11-03"))).toBe(3);
    expect(nightsBetween(d("2026-03-29"), d("2026-03-30"))).toBe(1); // EU change
  });

  test("property: for every start and length 1..90 the nights are consecutive", () => {
    let start = d("2024-01-01");
    for (let i = 0; i < 800; i += 1) {
      for (const length of [1, 2, 7, 30, 89, 90]) {
        const end = addDays(start, length);
        const nights = eachNight(start, end);
        expect(nights).toHaveLength(length);
        expect(nightsBetween(start, end)).toBe(length);
        expect(isSameDate(nights[0], start)).toBe(true);
        expect(isBefore(nights[length - 1], end)).toBe(true);
        expect(isSameDate(addDays(nights[length - 1], 1), end)).toBe(true);
        for (let n = 1; n < nights.length; n += 1) {
          expect(nights[n].getTime() - nights[n - 1].getTime()).toBe(86400000);
        }
      }
      start = addDays(start, 1);
    }
  });

  test("a stay over 90 nights is rejected, 90 is allowed", () => {
    const start = d("2026-01-01");
    expect(eachNight(start, addDays(start, 90))).toHaveLength(90);
    expect(() => eachNight(start, addDays(start, 91))).toThrow(
      /at most 90 nights/,
    );
    // A huge range is rejected before any array is built.
    expect(() => eachNight(start, d("9999-12-31"))).toThrow(ValidationError);
    expect(eachNight(start, addDays(start, 120), { maxNights: 120 })).toHaveLength(
      120,
    );
  });
});

describe("todayIn", () => {
  const at = (s) => new Date(s);
  const day = (tz, instant) => formatDateOnly(todayIn(tz, at(instant)));

  test("defaults to Asia/Kolkata (UTC+5:30, no DST)", () => {
    expect(DEFAULT_TIMEZONE).toBe("Asia/Kolkata");
    expect(formatDateOnly(todayIn(undefined, at("2026-10-14T18:29:59Z")))).toBe(
      "2026-10-14",
    );
    expect(formatDateOnly(todayIn(undefined, at("2026-10-14T18:30:00Z")))).toBe(
      "2026-10-15",
    );
  });

  test("returns a date-only Date", () => {
    expect(isDateOnly(todayIn("Asia/Kolkata", at("2026-10-14T10:11:12.345Z")))).toBe(
      true,
    );
    expect(isDateOnly(todayIn())).toBe(true);
  });

  test("America/New_York around the spring-forward change (2026-03-08)", () => {
    const tz = "America/New_York";
    expect(day(tz, "2026-03-08T04:59:59Z")).toBe("2026-03-07"); // 23:59:59 EST
    expect(day(tz, "2026-03-08T05:00:00Z")).toBe("2026-03-08"); // 00:00 EST
    expect(day(tz, "2026-03-08T06:59:59Z")).toBe("2026-03-08"); // 01:59:59 EST
    expect(day(tz, "2026-03-08T07:00:00Z")).toBe("2026-03-08"); // 03:00 EDT
    expect(day(tz, "2026-03-09T03:59:59Z")).toBe("2026-03-08"); // 23:59:59 EDT
    expect(day(tz, "2026-03-09T04:00:00Z")).toBe("2026-03-09"); // 00:00 EDT
  });

  test("America/New_York around the fall-back change (2026-11-01)", () => {
    const tz = "America/New_York";
    expect(day(tz, "2026-11-01T03:59:59Z")).toBe("2026-10-31"); // 23:59:59 EDT
    expect(day(tz, "2026-11-01T04:00:00Z")).toBe("2026-11-01"); // 00:00 EDT
    expect(day(tz, "2026-11-01T05:59:59Z")).toBe("2026-11-01"); // 01:59:59 EDT
    expect(day(tz, "2026-11-01T06:00:00Z")).toBe("2026-11-01"); // 01:00 EST
    expect(day(tz, "2026-11-02T04:59:59Z")).toBe("2026-11-01"); // 23:59:59 EST
    expect(day(tz, "2026-11-02T05:00:00Z")).toBe("2026-11-02"); // 00:00 EST
  });

  test("the same instant is a different day in different zones", () => {
    const instant = "2026-12-31T20:00:00Z";
    expect(day("Asia/Kolkata", instant)).toBe("2027-01-01");
    expect(day("UTC", instant)).toBe("2026-12-31");
    expect(day("America/Los_Angeles", instant)).toBe("2026-12-31");
    expect(day("Pacific/Kiritimati", instant)).toBe("2027-01-01"); // UTC+14
    expect(day("Pacific/Pago_Pago", "2026-01-01T05:00:00Z")).toBe("2025-12-31"); // UTC-11
  });

  test("leap day in a zone", () => {
    expect(day("Asia/Kolkata", "2024-02-28T18:30:00Z")).toBe("2024-02-29");
    expect(day("Asia/Kolkata", "2024-02-29T18:30:00Z")).toBe("2024-03-01");
  });

  test("property: hourly over a year, the day never goes backwards or skips", () => {
    for (const tz of ["Asia/Kolkata", "America/New_York", "Europe/London"]) {
      let previous = null;
      for (let hour = 0; hour < 24 * 366; hour += 1) {
        const instant = new Date(Date.UTC(2026, 0, 1) + hour * 3600000);
        const today = todayIn(tz, instant);
        if (previous) {
          const step = (today.getTime() - previous.getTime()) / 86400000;
          expect(step === 0 || step === 1).toBe(true);
        }
        previous = today;
      }
    }
  });

  test("unknown time zone is a ValidationError; bad arguments are TypeErrors", () => {
    expect(() => todayIn("Mars/Olympus_Mons")).toThrow(ValidationError);
    expect(() => todayIn("Mars/Olympus_Mons")).toThrow(/Unknown time zone/);
    expect(() => todayIn("")).toThrow(TypeError);
    expect(() => todayIn(null)).toThrow(TypeError);
    expect(() => todayIn("UTC", new Date(NaN))).toThrow(TypeError);
    expect(() => todayIn("UTC", "2026-01-01")).toThrow(TypeError);
  });
});

describe("booking window", () => {
  const today = d("2026-10-14");

  test("constants", () => {
    expect(BOOKING_WINDOW.MAX_HORIZON_DAYS).toBe(365);
    expect(BOOKING_WINDOW.MAX_STAY_NIGHTS).toBe(90);
    expect(BOOKING_WINDOW.MIN_ADVANCE_DAYS).toBe(0);
    expect(Object.isFrozen(BOOKING_WINDOW)).toBe(true);
  });

  test("bookingWindow returns today and today + 365 days", () => {
    const { earliestCheckIn, latestCheckIn } = bookingWindow(today);
    expect(formatDateOnly(earliestCheckIn)).toBe("2026-10-14");
    expect(formatDateOnly(latestCheckIn)).toBe("2027-10-14");
  });

  test("accepts check-in today and on the last allowed day", () => {
    expect(
      assertBookableDates({ checkIn: today, checkOut: d("2026-10-15"), today }),
    ).toBe(1);
    expect(
      assertBookableDates({
        checkIn: d("2027-10-14"),
        checkOut: d("2027-10-16"),
        today,
      }),
    ).toBe(2);
  });

  test("rejects a past check-in, one beyond the horizon, bad order and long stays", () => {
    expect(() =>
      assertBookableDates({
        checkIn: d("2026-10-13"),
        checkOut: d("2026-10-15"),
        today,
      }),
    ).toThrow(/cannot be in the past/);
    expect(() =>
      assertBookableDates({
        checkIn: d("2027-10-15"),
        checkOut: d("2027-10-16"),
        today,
      }),
    ).toThrow(/at most 365 days ahead/);
    expect(() =>
      assertBookableDates({ checkIn: today, checkOut: today, today }),
    ).toThrow(/Check-out must be after check-in/);
    expect(() =>
      assertBookableDates({
        checkIn: today,
        checkOut: addDays(today, 91),
        today,
      }),
    ).toThrow(/at most 90 nights/);
    expect(
      assertBookableDates({
        checkIn: today,
        checkOut: addDays(today, 90),
        today,
      }),
    ).toBe(90);
  });

  test("today comes from the listing's time zone", () => {
    // 20:00 UTC on 14 Oct is already 15 Oct in Kolkata: 14 Oct is in the past.
    const instant = new Date("2026-10-14T20:00:00Z");
    const kolkataToday = todayIn("Asia/Kolkata", instant);
    expect(() =>
      assertBookableDates({
        checkIn: d("2026-10-14"),
        checkOut: d("2026-10-15"),
        today: kolkataToday,
      }),
    ).toThrow(/cannot be in the past/);
    const utcToday = todayIn("UTC", instant);
    expect(
      assertBookableDates({
        checkIn: d("2026-10-14"),
        checkOut: d("2026-10-15"),
        today: utcToday,
      }),
    ).toBe(1);
  });
});
