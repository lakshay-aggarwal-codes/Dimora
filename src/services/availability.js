// Host availability calendar (P07-T03).
//
//   monthView(listing, monthValue, { now })   the month grid, as plain data
//   listBlocks(listing, { now })              the host's upcoming blocked runs
//   blockDates(listing, input, { now, userId })
//   unblockDates(listing, input, { now })
//
// The night ledger (ADR-004) is the only source of truth for what is taken:
// a reserved night, a pending request's live hold and a host block are all
// rows in it. A block is made with `reserveNights(..., { kind: "block" })`, so
// the unique (listing, date) index refuses a night a guest already holds, even
// when the guest books at the same moment. Unblocking releases only rows whose
// source kind is "block". The optional note lives in an AvailabilityBlock
// record whose _id is the ledger source id.
//
// Dates are strict YYYY-MM-DD strings parsed by src/utils/dates.js (ADR-003);
// "today" is the listing's own time zone's calendar date.
const mongoose = require("mongoose");
const ledgerService = require("./ledger");
const AvailabilityBlockModel = require("../models/availabilityBlock");
const { ConflictError, ValidationError } = require("../utils/errors");
const {
  BOOKING_WINDOW,
  DEFAULT_TIMEZONE,
  addDays,
  addMonths,
  daysInMonth,
  eachNight,
  formatDateOnly,
  formatMonthKey,
  isoWeekday,
  isBefore,
  isAfter,
  nightsBetween,
  parseMonthKey,
  startOfMonth,
  todayIn,
  tryParseDateOnly,
} = require("../utils/dates");

const NOTE_MAX_LENGTH = 200;
const MONTHS_BACK = 12; // how far back the host may look
const MAX_RUNS_LISTED = 100;
const LIST_SPAN_DAYS = 400; // the ledger's longest range
const PLURAL = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Fixed English names rather than Intl: the text must not change with the
// server's ICU version, and a date-only value has no time zone to apply.
const MONTH_NAMES = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);
const monthLabel = (date) =>
  `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
/** "5 Nov 2026" */
const shortDay = (date) =>
  `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()].slice(0, 3)} ${date.getUTCFullYear()}`;
/** "Tuesday 3 November 2026" */
const fullDay = (date) =>
  `${WEEKDAYS[isoWeekday(date)].long} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

// Monday first. `long` is for assistive technology (abbr attribute).
const WEEKDAYS = Object.freeze([
  { short: "Mon", long: "Monday" },
  { short: "Tue", long: "Tuesday" },
  { short: "Wed", long: "Wednesday" },
  { short: "Thu", long: "Thursday" },
  { short: "Fri", long: "Friday" },
  { short: "Sat", long: "Saturday" },
  { short: "Sun", long: "Sunday" },
]);

const STATE_LABELS = Object.freeze({
  free: "",
  blocked: "Blocked",
  reserved: "Reserved",
  requested: "Request",
});
const STATE_WORDS = Object.freeze({
  free: "available",
  blocked: "blocked by you",
  reserved: "reserved by a guest",
  requested: "held for a guest request awaiting your answer",
});

/** Free text from a form: one line, no control characters, trimmed. */
function cleanNote(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new ValidationError("The note must be text.");
  }
  // eslint-disable-next-line no-control-regex
  const note = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ");
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw new ValidationError(
      `The note can be at most ${NOTE_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/**
 * The block / unblock form: first night, last night (both included) and an
 * optional note. Nights already in the past cannot be changed, and nothing
 * beyond the booking horizon can be blocked. Throws ValidationError (400)
 * with a message the host can act on.
 * @returns {{from: Date, through: Date, to: Date, nights: number, note: string}}
 */
function parseRange(input, { today, withNote = false }) {
  const body = input && typeof input === "object" ? input : {};
  const from = tryParseDateOnly(body.from);
  if (!from) {
    throw new ValidationError("Enter the first night as a valid date.");
  }
  const through = tryParseDateOnly(body.through);
  if (!through) {
    throw new ValidationError("Enter the last night as a valid date.");
  }
  if (isBefore(through, from)) {
    throw new ValidationError(
      "The last night cannot be before the first night.",
    );
  }
  if (isBefore(from, today)) {
    throw new ValidationError(
      "Nights that have already passed cannot be changed.",
    );
  }
  const latest = addDays(today, BOOKING_WINDOW.MAX_HORIZON_DAYS);
  if (isAfter(through, latest)) {
    throw new ValidationError(
      `You can change availability up to a year ahead (until ${formatDateOnly(latest)}).`,
    );
  }
  const to = addDays(through, 1);
  const nights = nightsBetween(from, to); // at most horizon + 1 (checked above)
  return {
    from,
    through,
    to,
    nights,
    note: withNote ? cleanNote(body.note) : "",
  };
}

const listDates = (dates) => dates.map(shortDay).join(", ");

/**
 * @param {object} [deps] replaceable in unit tests
 */
function createAvailabilityService({
  ledger = ledgerService,
  blockModel = AvailabilityBlockModel,
  newId = () => new mongoose.Types.ObjectId(),
} = {}) {
  const todayFor = (listing, now) =>
    todayIn(listing.timezone || DEFAULT_TIMEZONE, now);

  /** The months the host may open: a year back to the end of the horizon. */
  function monthBounds(today) {
    return {
      min: addMonths(today, -MONTHS_BACK),
      max: startOfMonth(addDays(today, BOOKING_WINDOW.MAX_HORIZON_DAYS)),
    };
  }

  /** First day of the month to show: the one asked for, else this month, kept in bounds. */
  function resolveMonth(value, today) {
    const { min, max } = monthBounds(today);
    let month = parseMonthKey(value) || startOfMonth(today);
    if (isBefore(month, min)) month = min;
    if (isAfter(month, max)) month = max;
    return month;
  }

  /** The month grid for one listing as plain data (nothing about guests). */
  async function monthView(listing, monthValue, { now = new Date() } = {}) {
    const today = todayFor(listing, now);
    const { min, max } = monthBounds(today);
    const month = resolveMonth(monthValue, today);
    const next = addMonths(month, 1);
    const rows = await ledger.nightsInRange(listing._id, month, next, { now });
    const byDate = new Map(rows.map((row) => [row.date.getTime(), row]));

    const counts = { blocked: 0, reserved: 0, requested: 0 };
    const cells = [];
    for (let i = 0; i < isoWeekday(month); i += 1) cells.push(null);
    for (let i = 0; i < daysInMonth(month); i += 1) {
      const date = addDays(month, i);
      const row = byDate.get(date.getTime());
      let state = "free";
      if (row) {
        if (row.source.kind === "block") state = "blocked";
        else state = row.holdExpiresAt ? "requested" : "reserved";
        counts[state] += 1;
      }
      const isToday = date.getTime() === today.getTime();
      const past = isBefore(date, today);
      cells.push({
        day: date.getUTCDate(),
        iso: formatDateOnly(date),
        state,
        stateLabel: STATE_LABELS[state],
        past,
        today: isToday,
        srLabel: `${fullDay(date)}: ${STATE_WORDS[state]}${isToday ? ", today" : ""}`,
      });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    return {
      monthKey: formatMonthKey(month),
      label: monthLabel(month),
      prevKey: isAfter(month, min) ? formatMonthKey(addMonths(month, -1)) : null,
      nextKey: isBefore(month, max) ? formatMonthKey(addMonths(month, 1)) : null,
      weekdays: WEEKDAYS,
      weeks,
      counts,
      todayIso: formatDateOnly(today),
      latestIso: formatDateOnly(addDays(today, BOOKING_WINDOW.MAX_HORIZON_DAYS)),
    };
  }

  /**
   * Upcoming blocked stretches (from today on), each a run of consecutive
   * nights of one block, soonest first, with the block's note.
   */
  async function listBlocks(listing, { now = new Date() } = {}) {
    const today = todayFor(listing, now);
    const rows = (
      await ledger.nightsInRange(
        listing._id,
        today,
        addDays(today, LIST_SPAN_DAYS),
        { now },
      )
    ).filter((row) => row.source.kind === "block");

    const open = new Map(); // source id -> the run still being extended
    const runs = [];
    for (const row of rows) {
      const key = String(row.source.id);
      const run = open.get(key);
      if (run && run.to.getTime() === row.date.getTime()) {
        run.to = addDays(row.date, 1);
        run.nights += 1;
      } else {
        const fresh = {
          sourceId: row.source.id,
          from: row.date,
          to: addDays(row.date, 1),
          nights: 1,
        };
        open.set(key, fresh);
        runs.push(fresh);
      }
    }
    runs.sort((a, b) => a.from.getTime() - b.from.getTime());
    const shown = runs.slice(0, MAX_RUNS_LISTED);

    const ids = [...new Set(shown.map((run) => String(run.sourceId)))];
    const records = ids.length
      ? await blockModel
          .find({ _id: { $in: shown.map((r) => r.sourceId) }, listing: listing._id })
          .lean()
      : [];
    const notes = new Map(records.map((r) => [String(r._id), r.note || ""]));

    return {
      truncated: runs.length > shown.length,
      runs: shown.map((run) => {
        const through = addDays(run.to, -1);
        return {
          nights: run.nights,
          nightsLabel: PLURAL(run.nights, "night", "nights"),
          fromIso: formatDateOnly(run.from),
          throughIso: formatDateOnly(through),
          fromLabel: shortDay(run.from),
          throughLabel: shortDay(through),
          note: notes.get(String(run.sourceId)) || "",
        };
      }),
    };
  }

  /**
   * Blocks the nights from `input.from` to `input.through` (both included).
   * Nights the host already blocked are skipped; a night a guest holds makes
   * the whole request fail (nothing is blocked).
   * @throws {ValidationError} bad dates or note (400)
   * @throws {ConflictError}   a guest holds some of the nights (409)
   * @returns {Promise<{changed: boolean, blocked: number, alreadyBlocked: number, from: Date}>}
   */
  async function blockDates(listing, input, { now = new Date(), userId } = {}) {
    const today = todayFor(listing, now);
    const range = parseRange(input, { today, withNote: true });
    const nights = eachNight(range.from, range.to, {
      maxNights: BOOKING_WINDOW.MAX_HORIZON_DAYS + 1,
    });

    const rows = await ledger.nightsInRange(listing._id, range.from, range.to, {
      now,
    });
    const heldByGuests = rows.filter((row) => row.source.kind !== "block");
    if (heldByGuests.length > 0) {
      const err = new ConflictError(
        `Guests already hold these nights, so they cannot be blocked: ${listDates(heldByGuests.map((r) => r.date))}. Nothing was blocked.`,
        { code: "nights_reserved" },
      );
      err.conflictingDates = heldByGuests.map((r) => r.date);
      throw err;
    }
    const alreadyBlocked = new Set(rows.map((row) => row.date.getTime()));
    const free = nights.filter((night) => !alreadyBlocked.has(night.getTime()));
    if (free.length === 0) {
      return {
        changed: false,
        blocked: 0,
        alreadyBlocked: nights.length,
        from: range.from,
      };
    }

    const blockId = newId();
    try {
      await ledger.reserveNights(
        listing._id,
        free,
        { kind: "block", id: blockId },
        null,
        { now },
      );
    } catch (err) {
      if (err instanceof ConflictError && err.code === "nights_unavailable") {
        const taken = err.conflictingDates || [];
        throw new ConflictError(
          taken.length
            ? `A guest just took these nights: ${listDates(taken)}. Nothing was blocked.`
            : "A guest just took some of those nights. Nothing was blocked.",
          { code: "nights_reserved" },
        );
      }
      throw err;
    }

    try {
      await blockModel.create({
        _id: blockId,
        listing: listing._id,
        from: range.from,
        to: range.to,
        note: range.note,
        createdBy: userId,
      });
    } catch (err) {
      await ledger.releaseNights(blockId); // no night without its record
      throw err;
    }
    return {
      changed: true,
      blocked: free.length,
      alreadyBlocked: nights.length - free.length,
      from: range.from,
    };
  }

  /**
   * Frees the blocked nights between `input.from` and `input.through` (both
   * included). Reserved nights and guest holds are never touched.
   * @returns {Promise<{released: number, from: Date}>}
   */
  async function unblockDates(listing, input, { now = new Date() } = {}) {
    const today = todayFor(listing, now);
    const range = parseRange(input, { today });
    const { released, emptiedSourceIds } = await ledger.releaseBlockedNights(
      listing._id,
      range.from,
      range.to,
    );
    if (emptiedSourceIds.length > 0) {
      await blockModel.deleteMany({
        _id: { $in: emptiedSourceIds },
        listing: listing._id,
      });
    }
    return { released, from: range.from };
  }

  return {
    monthView,
    listBlocks,
    blockDates,
    unblockDates,
    resolveMonth,
  };
}

module.exports = {
  ...createAvailabilityService(),
  createAvailabilityService,
  parseRange,
  cleanNote,
  NOTE_MAX_LENGTH,
};
