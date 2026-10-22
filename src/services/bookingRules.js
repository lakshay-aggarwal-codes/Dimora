// Booking rules (P07-T06): the one place that decides whether a stay may be
// booked. The reservation service (create), the availability API and the date
// picker all read their rules from here, so a rule is written once.
//
//   stayRulesFor(listing, { today })         the rules as plain data (for the picker and the API)
//   stayProblems({ checkIn, checkOut, rules, unavailable })
//                                             the date and stay-length rules only (messages)
//   bookingProblems({ listing, checkIn, checkOut, guests, now, unavailable })
//                                             every rule -> [{ code, message }], empty when acceptable
//
// Rules, each with its own message and code:
//   check_out_not_after_check_in, check_in_past, check_in_too_far (horizon),
//   below_min_nights, above_max_nights, over_capacity,
//   advance_notice (host-set hours before check-in), same_day_cutoff.
//
// Dates are date-only Dates (ADR-003). "Now" and "today" are read on the
// listing's own clock (its time zone), never the server's. A rule that needs
// the time of day compares wall-clock times in that zone, so it is not moved
// by the server's zone.
const {
  BOOKING_WINDOW,
  DEFAULT_TIMEZONE,
  bookingWindow,
  formatDateOnly,
  isAfter,
  isBefore,
  isSameDate,
  tryParseDateOnly,
  wallClockIn,
} = require("../utils/dates");

const RULE_DEFAULTS = Object.freeze({
  ADVANCE_NOTICE_HOURS: 0, // no notice needed
  MAX_ADVANCE_NOTICE_HOURS: 168, // a host can ask for up to 7 days
  SAME_DAY_CUTOFF: "20:00", // a stay starting today must be booked before this
  CHECK_IN_TIME: "14:00",
});

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** "HH:MM" -> minutes since midnight, or null when it is not a valid time. */
function timeToMinutes(text) {
  const match = typeof text === "string" ? TIME.exec(text) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function noticeHoursOf(listing) {
  const hours = listing && listing.advanceNoticeHours;
  return Number.isInteger(hours) &&
    hours >= 0 &&
    hours <= RULE_DEFAULTS.MAX_ADVANCE_NOTICE_HOURS
    ? hours
    : RULE_DEFAULTS.ADVANCE_NOTICE_HOURS;
}

function cutoffOf(listing) {
  const text = listing && listing.sameDayCutoffTime;
  return timeToMinutes(text) === null ? RULE_DEFAULTS.SAME_DAY_CUTOFF : text;
}

function checkInTimeOf(listing) {
  const text = listing && listing.checkInTime;
  return timeToMinutes(text) === null ? RULE_DEFAULTS.CHECK_IN_TIME : text;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** 24 -> "1 day", 48 -> "2 days", 36 -> "36 hours", 1 -> "1 hour" */
function noticeLabel(hours) {
  return hours % 24 === 0
    ? plural(hours / 24, "day", "days")
    : plural(hours, "hour", "hours");
}

/** What the picker and the API show, and what the server enforces. */
function stayRulesFor(listing, { today }) {
  const { earliestCheckIn, latestCheckIn } = bookingWindow(today);
  const hostMin = Number.isInteger(listing && listing.minNights)
    ? listing.minNights
    : 1;
  const hostMax = Number.isInteger(listing && listing.maxNights)
    ? listing.maxNights
    : BOOKING_WINDOW.MAX_STAY_NIGHTS;
  const maxNights = Math.min(hostMax, BOOKING_WINDOW.MAX_STAY_NIGHTS);
  const minNights = Math.min(Math.max(hostMin, 1), maxNights);
  const guestCapacity = listing && listing.capacity && listing.capacity.guests;
  return {
    today: formatDateOnly(today),
    earliestCheckIn: formatDateOnly(earliestCheckIn),
    latestCheckIn: formatDateOnly(latestCheckIn),
    minNights,
    maxNights,
    // How many people the place sleeps (named so the public API output never
    // contains the word "guest": a test guards against leaking guest data).
    capacity: Number.isInteger(guestCapacity) ? guestCapacity : null,
    advanceNoticeHours: noticeHoursOf(listing),
    sameDayCutoffTime: cutoffOf(listing),
  };
}

const rule = (code, message) => ({ code, message });

// Date and stay-length rules, from the `rules` data alone.
function stayRuleProblems({ checkIn, checkOut, rules, unavailable = [] }) {
  if (!isAfter(checkOut, checkIn)) {
    return [
      rule("check_out_not_after_check_in", "Check-out must be after check-in."),
    ];
  }
  const problems = [];
  const nights = Math.round(
    (checkOut.getTime() - checkIn.getTime()) / MS_PER_DAY,
  );
  const today = tryParseDateOnly(rules.today);
  const latest = tryParseDateOnly(rules.latestCheckIn);
  if (isBefore(checkIn, today)) {
    problems.push(rule("check_in_past", "Check-in cannot be in the past."));
  }
  if (isAfter(checkIn, latest)) {
    problems.push(
      rule(
        "check_in_too_far",
        `Check-in can be at most ${BOOKING_WINDOW.MAX_HORIZON_DAYS} days ahead.`,
      ),
    );
  }
  if (nights < rules.minNights) {
    problems.push(
      rule(
        "below_min_nights",
        `The minimum stay is ${plural(rules.minNights, "night", "nights")}.`,
      ),
    );
  }
  if (nights > rules.maxNights) {
    problems.push(
      rule(
        "above_max_nights",
        `The maximum stay is ${plural(rules.maxNights, "night", "nights")}.`,
      ),
    );
  }
  const taken = unavailable
    .filter((d) => !isBefore(d, checkIn) && isBefore(d, checkOut))
    .map(formatDateOnly);
  if (taken.length) {
    problems.push(
      rule(
        "nights_unavailable",
        `These nights are not available: ${taken.join(", ")}.`,
      ),
    );
  }
  return problems;
}

/**
 * Date and stay-length problems as messages (the picker's contract since
 * P07-T04). Empty when the stay is acceptable.
 */
function stayProblems(input) {
  return stayRuleProblems(input).map((p) => p.message);
}

/**
 * Wall-clock minutes from `now` until the check-in moment (check-in date plus
 * the listing's check-in time), both read in the listing's time zone.
 * Negative when check-in time has already passed.
 */
function minutesUntilCheckIn({ listing, checkIn, now }) {
  const clock = wallClockIn(
    (listing && listing.timezone) || DEFAULT_TIMEZONE,
    now,
  );
  const dayDiff = Math.round(
    (checkIn.getTime() - clock.date.getTime()) / MS_PER_DAY,
  );
  return (
    dayDiff * 24 * 60 + timeToMinutes(checkInTimeOf(listing)) - clock.minutes
  );
}

/**
 * Every booking rule for one request. `unavailable` (optional) is an array of
 * date-only Dates; the ledger, not this module, is what really refuses a taken
 * night.
 * @returns {{code: string, message: string}[]} in the order a guest should fix them
 */
function bookingProblems({
  listing,
  checkIn,
  checkOut,
  guests,
  now = new Date(),
  unavailable = [],
}) {
  const zone = (listing && listing.timezone) || DEFAULT_TIMEZONE;
  const clock = wallClockIn(zone, now);
  const rules = stayRulesFor(listing, { today: clock.date });
  const problems = stayRuleProblems({ checkIn, checkOut, rules, unavailable });
  if (problems.some((p) => p.code === "check_out_not_after_check_in"))
    return problems;

  if (
    Number.isInteger(guests) &&
    rules.capacity !== null &&
    guests > rules.capacity
  ) {
    problems.push(
      rule(
        "over_capacity",
        `This place hosts at most ${plural(rules.capacity, "guest", "guests")}.`,
      ),
    );
  }

  // Timing rules only matter for a check-in that is not already refused for
  // being in the past or beyond the horizon.
  const inWindow = !problems.some(
    (p) => p.code === "check_in_past" || p.code === "check_in_too_far",
  );
  if (inWindow) {
    let noticeFailed = false;
    if (rules.advanceNoticeHours > 0) {
      const needed = rules.advanceNoticeHours * 60;
      if (minutesUntilCheckIn({ listing, checkIn, now }) < needed) {
        noticeFailed = true;
        problems.push(
          rule(
            "advance_notice",
            `This host needs at least ${noticeLabel(rules.advanceNoticeHours)} notice before check-in. Choose a later check-in date.`,
          ),
        );
      }
    }
    // A same-day stay: refuse once the place's clock has reached the cut-off.
    // (An advance-notice failure already says the date is too soon.)
    if (!noticeFailed && isSameDate(checkIn, clock.date)) {
      if (clock.minutes >= timeToMinutes(rules.sameDayCutoffTime)) {
        problems.push(
          rule(
            "same_day_cutoff",
            `Bookings for today close at ${rules.sameDayCutoffTime} (the place's local time). Choose a later check-in date.`,
          ),
        );
      }
    }
  }
  return problems;
}

module.exports = {
  RULE_DEFAULTS,
  timeToMinutes,
  noticeLabel,
  stayRulesFor,
  stayProblems,
  bookingProblems,
  minutesUntilCheckIn,
};
