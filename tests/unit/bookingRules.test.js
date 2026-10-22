// P07-T06: the booking rules module. Pure functions, an injected clock.
const {
  RULE_DEFAULTS,
  timeToMinutes,
  noticeLabel,
  stayRulesFor,
  stayProblems,
  bookingProblems,
  minutesUntilCheckIn,
} = require("../../src/services/bookingRules");
const {
  parseDateOnly,
  wallClockIn,
  formatDateOnly,
} = require("../../src/utils/dates");

const d = (s) => parseDateOnly(s);
const at = (s) => new Date(s);
// 2026-10-20 11:30 in Kolkata (UTC+5:30, no daylight saving).
const NOON = at("2026-10-20T06:00:00Z");
const TODAY = d("2026-10-20");

const listing = (extra = {}) => ({
  timezone: "Asia/Kolkata",
  checkInTime: "14:00",
  minNights: 1,
  maxNights: 14,
  capacity: { guests: 4 },
  ...extra,
});
const check = (over = {}, extra = {}) =>
  bookingProblems({
    listing: listing(extra),
    checkIn: d("2026-10-25"),
    checkOut: d("2026-10-28"),
    guests: 2,
    now: NOON,
    ...over,
  });
const codes = (problems) => problems.map((p) => p.code);

describe("wallClockIn", () => {
  test("date and minutes on the place's clock", () => {
    const clock = wallClockIn("Asia/Kolkata", NOON);
    expect(formatDateOnly(clock.date)).toBe("2026-10-20");
    expect(clock.minutes).toBe(11 * 60 + 30);
  });
  test("midnight is minute 0, not 1440", () => {
    expect(wallClockIn("UTC", at("2026-10-20T00:00:00Z")).minutes).toBe(0);
    expect(
      wallClockIn("Asia/Kolkata", at("2026-10-19T18:30:00Z")).minutes,
    ).toBe(0);
  });
  test("a different zone can be on a different date", () => {
    const instant = at("2026-10-20T20:00:00Z"); // 01:30 on the 21st in Kolkata
    expect(formatDateOnly(wallClockIn("Asia/Kolkata", instant).date)).toBe(
      "2026-10-21",
    );
    expect(formatDateOnly(wallClockIn("America/New_York", instant).date)).toBe(
      "2026-10-20",
    );
    expect(wallClockIn("America/New_York", instant).minutes).toBe(16 * 60);
  });
});

describe("helpers", () => {
  test("timeToMinutes", () => {
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("20:30")).toBe(1230);
    for (const bad of ["24:00", "7:00", "20:60", "", null, undefined, 5]) {
      expect(timeToMinutes(bad)).toBeNull();
    }
  });
  test("noticeLabel", () => {
    expect(noticeLabel(1)).toBe("1 hour");
    expect(noticeLabel(36)).toBe("36 hours");
    expect(noticeLabel(24)).toBe("1 day");
    expect(noticeLabel(48)).toBe("2 days");
  });
});

describe("stayRulesFor", () => {
  test("host values and defaults", () => {
    expect(
      stayRulesFor(
        listing({
          minNights: 2,
          maxNights: 10,
          advanceNoticeHours: 24,
          sameDayCutoffTime: "18:00",
        }),
        { today: TODAY },
      ),
    ).toEqual({
      today: "2026-10-20",
      earliestCheckIn: "2026-10-20",
      latestCheckIn: "2027-10-20",
      minNights: 2,
      maxNights: 10,
      capacity: 4,
      advanceNoticeHours: 24,
      sameDayCutoffTime: "18:00",
    });
    const plain = stayRulesFor(listing(), { today: TODAY });
    expect(plain.advanceNoticeHours).toBe(RULE_DEFAULTS.ADVANCE_NOTICE_HOURS);
    expect(plain.sameDayCutoffTime).toBe(RULE_DEFAULTS.SAME_DAY_CUTOFF);
  });
  test("a listing without the new fields, or with bad ones, gets the defaults", () => {
    for (const bad of [-1, 169, 1.5, "24", null, NaN]) {
      expect(
        stayRulesFor(listing({ advanceNoticeHours: bad }), { today: TODAY })
          .advanceNoticeHours,
      ).toBe(0);
    }
    for (const bad of ["25:00", "8pm", "", null, 20]) {
      expect(
        stayRulesFor(listing({ sameDayCutoffTime: bad }), { today: TODAY })
          .sameDayCutoffTime,
      ).toBe("20:00");
    }
  });
  test("stay length is clamped to the platform maximum and to at least 1", () => {
    const rules = stayRulesFor(listing({ minNights: 0, maxNights: 365 }), {
      today: TODAY,
    });
    expect(rules.minNights).toBe(1);
    expect(rules.maxNights).toBe(90);
  });
  test("no capacity on the listing means no guest rule", () => {
    expect(
      stayRulesFor({ timezone: "Asia/Kolkata" }, { today: TODAY }).capacity,
    ).toBeNull();
  });
});

describe("stayProblems (messages, as the date picker contract)", () => {
  const rules = stayRulesFor(listing({ minNights: 2, maxNights: 5 }), {
    today: TODAY,
  });
  const problems = (checkIn, checkOut, unavailable) =>
    stayProblems({
      checkIn: d(checkIn),
      checkOut: d(checkOut),
      rules,
      unavailable,
    });
  test("acceptable stay", () =>
    expect(problems("2026-10-25", "2026-10-28")).toEqual([]));
  test("messages", () => {
    expect(problems("2026-10-25", "2026-10-25")).toEqual([
      "Check-out must be after check-in.",
    ]);
    expect(problems("2026-10-18", "2026-10-21")).toEqual([
      "Check-in cannot be in the past.",
    ]);
    expect(problems("2026-10-25", "2026-10-26")).toEqual([
      "The minimum stay is 2 nights.",
    ]);
    expect(problems("2026-10-25", "2026-11-05")).toEqual([
      "The maximum stay is 5 nights.",
    ]);
    expect(problems("2027-10-25", "2027-10-27")).toEqual([
      "Check-in can be at most 365 days ahead.",
    ]);
    expect(problems("2026-10-25", "2026-10-27", [d("2026-10-26")])).toEqual([
      "These nights are not available: 2026-10-26.",
    ]);
  });
  test("the check-out day itself may be taken", () => {
    expect(problems("2026-10-25", "2026-10-27", [d("2026-10-27")])).toEqual([]);
  });
  test("a singular minimum reads naturally", () => {
    const one = stayRulesFor(listing({ minNights: 1, maxNights: 1 }), {
      today: TODAY,
    });
    expect(
      stayProblems({
        checkIn: d("2026-10-25"),
        checkOut: d("2026-10-27"),
        rules: one,
      }),
    ).toEqual(["The maximum stay is 1 night."]);
  });
});

describe("bookingProblems: one rule at a time, one code each", () => {
  test("an acceptable booking", () => expect(check()).toEqual([]));

  test.each([
    [
      "check-out not after check-in",
      { checkOut: d("2026-10-25") },
      {},
      "check_out_not_after_check_in",
      /Check-out must be after check-in/,
    ],
    [
      "check-in in the past",
      { checkIn: d("2026-10-19"), checkOut: d("2026-10-22") },
      {},
      "check_in_past",
      /cannot be in the past/,
    ],
    [
      "check-in beyond the horizon",
      { checkIn: d("2027-10-21"), checkOut: d("2027-10-23") },
      {},
      "check_in_too_far",
      /at most 365 days ahead/,
    ],
    [
      "below the minimum stay",
      { checkOut: d("2026-10-26") },
      { minNights: 2 },
      "below_min_nights",
      /minimum stay is 2 nights/,
    ],
    [
      "above the maximum stay",
      { checkOut: d("2026-10-31") },
      { maxNights: 3 },
      "above_max_nights",
      /maximum stay is 3 nights/,
    ],
    [
      "more guests than the capacity",
      { guests: 5 },
      {},
      "over_capacity",
      /at most 4 guests/,
    ],
    [
      "one-guest place",
      { guests: 2 },
      { capacity: { guests: 1 } },
      "over_capacity",
      /at most 1 guest\./,
    ],
  ])("%s", (_name, over, extra, code, message) => {
    const problems = check(over, extra);
    expect(codes(problems)).toEqual([code]);
    expect(problems[0].message).toMatch(message);
  });

  test("every rule has a different message", () => {
    const seen = new Set();
    for (const [over, extra] of [
      [{ checkOut: d("2026-10-25") }, {}],
      [{ checkIn: d("2026-10-19"), checkOut: d("2026-10-22") }, {}],
      [{ checkIn: d("2027-10-21"), checkOut: d("2027-10-23") }, {}],
      [{ checkOut: d("2026-10-26") }, { minNights: 2 }],
      [{ checkOut: d("2026-10-31") }, { maxNights: 3 }],
      [{ guests: 5 }, {}],
      [
        { checkIn: d("2026-10-21"), checkOut: d("2026-10-23") },
        { advanceNoticeHours: 48 },
      ],
      [
        {
          checkIn: d("2026-10-20"),
          checkOut: d("2026-10-22"),
          now: at("2026-10-20T15:00:00Z"),
        },
        {},
      ],
    ]) {
      seen.add(check(over, extra)[0].message);
    }
    expect(seen.size).toBe(8);
  });

  test("a stay that breaks two rules lists both, stay rules first", () => {
    expect(
      codes(check({ guests: 9, checkOut: d("2026-10-26") }, { minNights: 2 })),
    ).toEqual(["below_min_nights", "over_capacity"]);
  });

  test("guest counts that are not whole numbers are left to the caller's own validation", () => {
    expect(check({ guests: undefined })).toEqual([]);
  });

  test("unavailable nights are reported when the caller supplies them", () => {
    expect(codes(check({ unavailable: [d("2026-10-26")] }))).toEqual([
      "nights_unavailable",
    ]);
  });
});

describe("advance notice (host-set hours before check-in)", () => {
  // Check-in 21 Oct 14:00; now is 20 Oct 11:30 -> 26.5 h away.
  const tomorrow = { checkIn: d("2026-10-21"), checkOut: d("2026-10-23") };
  test("26.5 hours away", () => {
    expect(
      minutesUntilCheckIn({
        listing: listing(),
        checkIn: d("2026-10-21"),
        now: NOON,
      }),
    ).toBe(26 * 60 + 30);
  });
  test("enough notice", () =>
    expect(check(tomorrow, { advanceNoticeHours: 24 })).toEqual([]));
  test("exactly the notice is enough", () => {
    expect(
      check(
        { ...tomorrow, now: at("2026-10-20T08:30:00Z") },
        { advanceNoticeHours: 24 },
      ),
    ).toEqual([]); // 14:00 -> 24.0 h
  });
  test("one minute short is refused with the notice in the message", () => {
    const problems = check(
      { ...tomorrow, now: at("2026-10-20T08:31:00Z") },
      { advanceNoticeHours: 24 },
    );
    expect(codes(problems)).toEqual(["advance_notice"]);
    expect(problems[0].message).toBe(
      "This host needs at least 1 day notice before check-in. Choose a later check-in date.",
    );
  });
  test("the message names hours when it is not a whole number of days", () => {
    expect(check(tomorrow, { advanceNoticeHours: 36 })[0].message).toMatch(
      /at least 36 hours notice/,
    );
  });
  test("a long notice also refuses a same-day check-in, with the notice message only", () => {
    const problems = check(
      { checkIn: d("2026-10-20"), checkOut: d("2026-10-22") },
      { advanceNoticeHours: 48 },
    );
    expect(codes(problems)).toEqual(["advance_notice"]);
  });
  test("it is measured to the listing's own check-in time", () => {
    const late = { advanceNoticeHours: 24, checkInTime: "16:00" }; // 28.5 h away: fine
    const early = { advanceNoticeHours: 27, checkInTime: "09:00" }; // 21.5 h away: refused
    expect(check(tomorrow, late)).toEqual([]);
    expect(codes(check(tomorrow, early))).toEqual(["advance_notice"]);
  });
  test("a listing without a usable check-in time counts from 14:00", () => {
    expect(
      minutesUntilCheckIn({
        listing: listing({ checkInTime: "late" }),
        checkIn: d("2026-10-21"),
        now: NOON,
      }),
    ).toBe(26 * 60 + 30);
  });
  test("no notice (0, missing) adds no rule", () => {
    expect(check(tomorrow, { advanceNoticeHours: 0 })).toEqual([]);
    expect(check(tomorrow, { advanceNoticeHours: undefined })).toEqual([]);
  });
  test("a check-in already refused as past is not also refused for notice", () => {
    expect(
      codes(
        check(
          { checkIn: d("2026-10-19"), checkOut: d("2026-10-21") },
          { advanceNoticeHours: 24 },
        ),
      ),
    ).toEqual(["check_in_past"]);
  });
});

describe("same-day cut-off", () => {
  const today = { checkIn: d("2026-10-20"), checkOut: d("2026-10-22") };
  test("before the default 20:00 cut-off a same-day stay is accepted", () => {
    expect(check({ ...today, now: at("2026-10-20T14:29:00Z") })).toEqual([]); // 19:59 in Kolkata
  });
  test("at the cut-off it is refused", () => {
    const problems = check({ ...today, now: at("2026-10-20T14:30:00Z") }); // 20:00
    expect(codes(problems)).toEqual(["same_day_cutoff"]);
    expect(problems[0].message).toBe(
      "Bookings for today close at 20:00 (the place's local time). Choose a later check-in date.",
    );
  });
  test("a host-set cut-off", () => {
    expect(codes(check(today, { sameDayCutoffTime: "11:00" }))).toEqual([
      "same_day_cutoff",
    ]); // it is 11:30
    expect(check(today, { sameDayCutoffTime: "11:31" })).toEqual([]);
  });
  test("a cut-off of 23:59 allows almost the whole day", () => {
    expect(
      check(
        { ...today, now: at("2026-10-20T18:28:00Z") },
        { sameDayCutoffTime: "23:59" },
      ),
    ).toEqual([]); // 23:58
    expect(
      codes(
        check(
          { ...today, now: at("2026-10-20T18:29:00Z") },
          { sameDayCutoffTime: "23:59" },
        ),
      ),
    ).toEqual(["same_day_cutoff"]);
  });
  test("tomorrow is never a same-day booking, even at 23:59", () => {
    expect(
      check({
        checkIn: d("2026-10-21"),
        checkOut: d("2026-10-23"),
        now: at("2026-10-20T18:29:00Z"),
      }),
    ).toEqual([]);
  });
  test("it follows the listing's clock, not the server's", () => {
    // 20:00 UTC on the 20th: 01:30 on the 21st in Kolkata, 16:00 on the 20th in New York.
    const now = at("2026-10-20T20:00:00Z");
    const stay = { checkIn: d("2026-10-20"), checkOut: d("2026-10-22"), now };
    expect(codes(check(stay, { timezone: "Asia/Kolkata" }))).toEqual([
      "check_in_past",
    ]);
    expect(check(stay, { timezone: "America/New_York" })).toEqual([]);
    expect(
      codes(
        check(
          { ...stay, now: at("2026-10-21T00:30:00Z") },
          { timezone: "America/New_York" },
        ),
      ),
    ).toEqual(["same_day_cutoff"]); // 20:30 EDT
  });
});
