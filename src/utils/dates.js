// Calendar-date helpers (ADR-003, P07-T01).
//
// A stay date is a calendar date stored as a Date at 00:00:00.000Z ("date-only
// Date"). It is parsed only from a strict YYYY-MM-DD string and never with
// `new Date(userString)`, whose result depends on the input format and the
// server's time zone. All arithmetic here is UTC-only, so DST changes cannot
// move a date. A stay of N nights occupies check-in .. check-out minus one day;
// the check-out day itself is not an occupied night.
//
// "Today" for any rule is a calendar date in the listing's time zone
// (todayIn). Instants (createdAt, holdExpiresAt...) stay ordinary Dates.
const { ValidationError } = require("./errors");

const DEFAULT_TIMEZONE = "Asia/Kolkata";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Booking-window limits shared by search, quotes and booking. Host-set advance
// notice and same-day cut-offs are added by P07-T06 on top of these.
const BOOKING_WINDOW = Object.freeze({
  MIN_ADVANCE_DAYS: 0, // earliest check-in = today (listing time zone)
  MAX_HORIZON_DAYS: 365, // latest check-in = today + 365 days
  MAX_STAY_NIGHTS: 90, // longest single stay
});

// Four-digit year starting 1-9 (so Date.UTC never maps a year to 19xx), ASCII
// digits only, no spaces, no time part, no trailing newline.
const DATE_ONLY = /^([1-9]\d{3})-(\d{2})-(\d{2})$/;

/** True for a valid Date at exactly 00:00:00.000Z. */
function isDateOnly(value) {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getTime() % MS_PER_DAY === 0
  );
}

function assertDateOnly(value, name) {
  if (!isDateOnly(value)) {
    throw new TypeError(
      `${name} must be a date-only Date (00:00:00.000Z); got ${String(value)}`,
    );
  }
}

/**
 * Strict parse of "YYYY-MM-DD" into a date-only Date, or null when the value is
 * not a string in that exact form or is not a real calendar date
 * (2026-02-30, 2026-13-01, 2026-1-5, 2026-01-05T00:00:00Z, " 2026-01-05"...).
 */
function tryParseDateOnly(value) {
  if (typeof value !== "string") return null;
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 30 February over to March; reject anything that moved.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Like tryParseDateOnly but throws a ValidationError (400) with a clear message. */
function parseDateOnly(value, label = "Date") {
  const date = tryParseDateOnly(value);
  if (!date) {
    throw new ValidationError(
      `${label} must be a valid date in YYYY-MM-DD format.`,
    );
  }
  return date;
}

/** "YYYY-MM-DD" for a date-only Date. */
function formatDateOnly(date) {
  assertDateOnly(date, "date");
  return date.toISOString().slice(0, 10);
}

/** The date-only Date `days` calendar days after `date` (negative = before). */
function addDays(date, days) {
  assertDateOnly(date, "date");
  if (!Number.isInteger(days)) {
    throw new TypeError(`days must be an integer; got ${String(days)}`);
  }
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function compareDates(a, b) {
  assertDateOnly(a, "first date");
  assertDateOnly(b, "second date");
  const diff = a.getTime() - b.getTime();
  return diff < 0 ? -1 : diff > 0 ? 1 : 0;
}

const isBefore = (a, b) => compareDates(a, b) < 0;
const isAfter = (a, b) => compareDates(a, b) > 0;
const isSameDate = (a, b) => compareDates(a, b) === 0;

/** Number of nights from check-in to check-out. Check-out must be after check-in. */
function nightsBetween(checkIn, checkOut) {
  assertDateOnly(checkIn, "checkIn");
  assertDateOnly(checkOut, "checkOut");
  const nights = (checkOut.getTime() - checkIn.getTime()) / MS_PER_DAY;
  if (nights <= 0) {
    throw new ValidationError("Check-out must be after check-in.");
  }
  return nights;
}

/**
 * The occupied nights of a stay as date-only Dates: check-in up to, but not
 * including, check-out. Stays longer than `maxNights` (default 90) are
 * rejected, so a huge range can never allocate a huge array.
 */
function eachNight(
  checkIn,
  checkOut,
  { maxNights = BOOKING_WINDOW.MAX_STAY_NIGHTS } = {},
) {
  const count = nightsBetween(checkIn, checkOut);
  if (count > maxNights) {
    throw new ValidationError(`A stay can be at most ${maxNights} nights.`);
  }
  const nights = [];
  for (let i = 0; i < count; i += 1) nights.push(addDays(checkIn, i));
  return nights;
}

/**
 * Today's calendar date in an IANA time zone, as a date-only Date.
 * `now` is injectable so rules can be tested at exact instants.
 */
function todayIn(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  if (typeof timeZone !== "string" || !timeZone) {
    throw new TypeError("timeZone must be a non-empty IANA time zone name");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new ValidationError(`Unknown time zone: ${timeZone}`);
    }
    throw err;
  }
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

/** First and last allowed check-in date for a given "today". */
function bookingWindow(today) {
  assertDateOnly(today, "today");
  return {
    earliestCheckIn: addDays(today, BOOKING_WINDOW.MIN_ADVANCE_DAYS),
    latestCheckIn: addDays(today, BOOKING_WINDOW.MAX_HORIZON_DAYS),
  };
}

/**
 * Checks a stay against the booking-window constants and returns its number of
 * nights. Throws a ValidationError whose message names the rule that failed.
 */
function assertBookableDates({ checkIn, checkOut, today }) {
  const { earliestCheckIn, latestCheckIn } = bookingWindow(today);
  assertDateOnly(checkIn, "checkIn");
  if (isBefore(checkIn, earliestCheckIn)) {
    throw new ValidationError(
      BOOKING_WINDOW.MIN_ADVANCE_DAYS === 0
        ? "Check-in cannot be in the past."
        : `Check-in must be at least ${BOOKING_WINDOW.MIN_ADVANCE_DAYS} day(s) from today.`,
    );
  }
  if (isAfter(checkIn, latestCheckIn)) {
    throw new ValidationError(
      `Check-in can be at most ${BOOKING_WINDOW.MAX_HORIZON_DAYS} days ahead.`,
    );
  }
  const nights = nightsBetween(checkIn, checkOut);
  if (nights > BOOKING_WINDOW.MAX_STAY_NIGHTS) {
    throw new ValidationError(
      `A stay can be at most ${BOOKING_WINDOW.MAX_STAY_NIGHTS} nights.`,
    );
  }
  return nights;
}

module.exports = {
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
};
