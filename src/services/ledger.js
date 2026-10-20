// Night-ledger service (ADR-004, P07-T02): the only code that reads or writes
// StayNight rows.
//
//   reserveNights(listingId, nights, source, holdExpiresAt?, { now }?)
//   releaseNights(sourceId)
//   availableRanges(listingId, from, to, { now }?)
//   nightsInRange(listingId, from, to, { now }?)       (P07-T03: calendar)
//   releaseBlockedNights(listingId, from, to)          (P07-T03: unblock)
//
// Booking works by inserting one row per night with `insertMany(...,
// { ordered: true })`. The unique (listing, date) index rejects a night that is
// already held (duplicate key, code 11000); the attempt then deletes the rows
// it had inserted and reports a ConflictError (409). Nights are always
// inserted in ascending order, so two overlapping requests cannot each hold
// part of the other's range and both fail forever: whoever takes the first
// contested night wins the rest. A losing request can still see a short-lived
// conflict caused by another attempt's rows that are about to be rolled back;
// the caller may simply retry.
//
// An expired hold (holdExpiresAt in the past) no longer blocks anyone: on a
// collision the service deletes those stale rows (conditional delete, so a
// row that was confirmed in the meantime is never touched) and retries once.
const mongoose = require("mongoose");
const StayNightModel = require("../models/stayNight");
const { ConflictError } = require("../utils/errors");
const {
  isDateOnly,
  addDays,
  formatDateOnly,
  todayIn,
} = require("../utils/dates");

// A booking is at most 90 nights; a host block may be longer (a season).
const MAX_NIGHTS_PER_CALL = 366;
const MAX_AVAILABILITY_SPAN_DAYS = 400;
const SOURCE_KINDS = ["reservation", "block"];

function isDuplicateKeyError(err) {
  if (!err) return false;
  if (err.code === 11000) return true;
  const writeErrors = [].concat(err.writeErrors || []);
  return writeErrors.some((e) => e && e.code === 11000);
}

/**
 * @param {object} [deps] replaceable in unit tests
 * @param {object} [deps.model]     the StayNight model
 * @param {Function} [deps.newId]   returns a new ObjectId
 * @param {Function} [deps.isValidId] true for a usable ObjectId
 */
function createLedgerService({
  model = StayNightModel,
  newId = () => new mongoose.Types.ObjectId(),
  isValidId = (value) => mongoose.isValidObjectId(value),
} = {}) {
  function requireId(value, name) {
    if (!isValidId(value)) {
      throw new TypeError(`${name} must be a valid ObjectId`);
    }
    return value;
  }

  function normalizeNights(nights) {
    if (!Array.isArray(nights) || nights.length === 0) {
      throw new TypeError("nights must be a non-empty array of dates");
    }
    if (nights.length > MAX_NIGHTS_PER_CALL) {
      throw new TypeError(
        `at most ${MAX_NIGHTS_PER_CALL} nights can be reserved in one call`,
      );
    }
    for (const night of nights) {
      if (!isDateOnly(night)) {
        throw new TypeError("every night must be a date-only Date (00:00:00Z)");
      }
    }
    const sorted = [...nights].sort((a, b) => a.getTime() - b.getTime());
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].getTime() === sorted[i - 1].getTime()) {
        throw new TypeError("nights must not contain the same date twice");
      }
    }
    return sorted;
  }

  function normalizeSource(source) {
    if (!source || !SOURCE_KINDS.includes(source.kind)) {
      throw new TypeError(
        `source.kind must be one of ${SOURCE_KINDS.join(", ")}`,
      );
    }
    return { kind: source.kind, id: requireId(source.id, "source.id") };
  }

  function normalizeHold(holdExpiresAt, now) {
    if (holdExpiresAt === null || holdExpiresAt === undefined) return null;
    if (
      !(holdExpiresAt instanceof Date) ||
      !Number.isFinite(holdExpiresAt.getTime())
    ) {
      throw new TypeError("holdExpiresAt must be a valid Date or null");
    }
    if (holdExpiresAt.getTime() <= now.getTime()) {
      throw new TypeError("holdExpiresAt must be in the future");
    }
    return holdExpiresAt;
  }

  const isStale = (row, now) =>
    Boolean(row.holdExpiresAt) && row.holdExpiresAt.getTime() < now.getTime();

  async function conflictError(listing, nights, now) {
    const rows = await model.find({ listing, date: { $in: nights } }).lean();
    const taken = rows
      .filter((row) => !isStale(row, now))
      .map((row) => row.date)
      .sort((a, b) => a.getTime() - b.getTime());
    const message = taken.length
      ? `These nights are no longer available: ${taken.map(formatDateOnly).join(", ")}.`
      : "Those nights are no longer available.";
    const err = new ConflictError(message, { code: "nights_unavailable" });
    err.conflictingDates = taken;
    return err;
  }

  /**
   * Holds every night for `source`, all or nothing.
   * @returns {Promise<{reserved: number, nights: Date[]}>}
   * @throws {ConflictError} code "nights_unavailable", with `conflictingDates`
   */
  async function reserveNights(
    listingId,
    nights,
    source,
    holdExpiresAt = null,
    { now = new Date() } = {},
  ) {
    const listing = requireId(listingId, "listingId");
    const sorted = normalizeNights(nights);
    const owner = normalizeSource(source);
    const hold = normalizeHold(holdExpiresAt, now);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // Fresh _ids per attempt: compensation deletes exactly these rows, never
      // rows another attempt (or an earlier call for the same source) holds.
      const docs = sorted.map((date) => ({
        _id: newId(),
        listing,
        date,
        source: owner,
        ...(hold ? { holdExpiresAt: hold } : {}),
      }));
      try {
        await model.insertMany(docs, { ordered: true });
        return { reserved: docs.length, nights: sorted };
      } catch (err) {
        try {
          await model.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
        } catch (cleanupErr) {
          const failure = new Error(
            "Night ledger compensation failed; orphaned rows may remain",
            { cause: err },
          );
          failure.cleanupError = cleanupErr;
          throw failure;
        }
        if (!isDuplicateKeyError(err)) throw err;

        if (attempt === 1) {
          const { deletedCount } = await model.deleteMany({
            listing,
            date: { $in: sorted },
            holdExpiresAt: { $lt: now },
          });
          if (deletedCount > 0) continue; // a stale hold was in the way: retry once
        }
        throw await conflictError(listing, sorted, now);
      }
    }
    throw new Error("unreachable"); // the loop always returns or throws
  }

  /**
   * Frees every night held by a reservation or block. Safe to call twice.
   * @returns {Promise<{released: number}>}
   */
  async function releaseNights(sourceId) {
    requireId(sourceId, "sourceId");
    const { deletedCount } = await model.deleteMany({ "source.id": sourceId });
    return { released: deletedCount };
  }

  /**
   * Free stretches inside [from, to): runs of consecutive nights nobody holds
   * (an expired hold counts as free). `to` is exclusive, so a range is a
   * valid check-in/check-out pair.
   * @returns {Promise<Array<{from: Date, to: Date, nights: number}>>}
   */
  async function availableRanges(
    listingId,
    from,
    to,
    { now = new Date() } = {},
  ) {
    const listing = requireId(listingId, "listingId");
    if (!isDateOnly(from) || !isDateOnly(to)) {
      throw new TypeError("from and to must be date-only Dates (00:00:00Z)");
    }
    const span = (to.getTime() - from.getTime()) / 86400000;
    if (span <= 0) throw new TypeError("to must be after from");
    if (span > MAX_AVAILABILITY_SPAN_DAYS) {
      throw new TypeError(
        `the range can cover at most ${MAX_AVAILABILITY_SPAN_DAYS} nights`,
      );
    }

    const rows = await model
      .find({ listing, date: { $gte: from, $lt: to } })
      .lean();
    const occupied = new Set(
      rows.filter((row) => !isStale(row, now)).map((row) => row.date.getTime()),
    );

    const ranges = [];
    let start = null;
    for (let i = 0; i < span; i += 1) {
      const day = addDays(from, i);
      if (occupied.has(day.getTime())) {
        if (start) {
          ranges.push({ from: start, to: day, nights: nightsOf(start, day) });
          start = null;
        }
      } else if (!start) {
        start = day;
      }
    }
    if (start) ranges.push({ from: start, to, nights: nightsOf(start, to) });
    return ranges;
  }

  function assertSpan(from, to) {
    if (!isDateOnly(from) || !isDateOnly(to)) {
      throw new TypeError("from and to must be date-only Dates (00:00:00Z)");
    }
    const span = (to.getTime() - from.getTime()) / 86400000;
    if (span <= 0) throw new TypeError("to must be after from");
    if (span > MAX_AVAILABILITY_SPAN_DAYS) {
      throw new TypeError(
        `the range can cover at most ${MAX_AVAILABILITY_SPAN_DAYS} nights`,
      );
    }
  }

  /**
   * Every occupied night of one listing inside [from, to), oldest first, as
   * { date, source: { kind, id }, holdExpiresAt }. An expired hold is left out
   * (it no longer blocks anyone). The calendar reads this; it carries no
   * guest information, only who owns the night.
   */
  async function nightsInRange(
    listingId,
    from,
    to,
    { now = new Date() } = {},
  ) {
    const listing = requireId(listingId, "listingId");
    assertSpan(from, to);
    const rows = await model
      .find({ listing, date: { $gte: from, $lt: to } })
      .lean();
    return rows
      .filter((row) => !isStale(row, now))
      .map((row) => ({
        date: row.date,
        source: { kind: row.source.kind, id: row.source.id },
        holdExpiresAt: row.holdExpiresAt || null,
      }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  /**
   * Frees the HOST-BLOCKED nights of one listing inside [from, to). Only rows
   * with source.kind "block" are touched: a reserved or held night is never
   * released here. Also reports which blocks have no night left, so the
   * caller can drop their records.
   * @returns {Promise<{released: number, emptiedSourceIds: any[]}>}
   */
  async function releaseBlockedNights(listingId, from, to) {
    const listing = requireId(listingId, "listingId");
    assertSpan(from, to);
    const filter = {
      listing,
      "source.kind": "block",
      date: { $gte: from, $lt: to },
    };
    const rows = await model.find(filter).lean();
    if (rows.length === 0) return { released: 0, emptiedSourceIds: [] };

    const sourceIds = new Map();
    for (const row of rows) sourceIds.set(String(row.source.id), row.source.id);

    const { deletedCount } = await model.deleteMany(filter);

    const emptiedSourceIds = [];
    for (const id of sourceIds.values()) {
      const left = await model.exists({ "source.id": id });
      if (!left) emptiedSourceIds.push(id);
    }
    return { released: deletedCount, emptiedSourceIds };
  }

  /**
   * Is any night of this listing, from today (in the listing's time zone)
   * onward, held by a reservation? A request whose hold has expired does not
   * count, and neither does a host block.
   */
  async function hasUpcomingReservation(
    listingId,
    { now = new Date(), timeZone } = {},
  ) {
    const listing = requireId(listingId, "listingId");
    const row = await model.exists({
      listing,
      "source.kind": "reservation",
      date: { $gte: todayIn(timeZone || undefined, now) },
      $or: [{ holdExpiresAt: null }, { holdExpiresAt: { $gt: now } }],
    });
    return Boolean(row);
  }

  /**
   * Ids of the listings that have at least one night in [from, to) taken: a
   * reservation, a live hold or a host block. Used by search to leave out
   * listings that cannot host a stay. An expired hold counts as free.
   */
  async function unavailableListingIds(from, to, { now = new Date() } = {}) {
    if (!isDateOnly(from) || !isDateOnly(to)) {
      throw new TypeError("from and to must be date-only Dates (00:00:00Z)");
    }
    const span = (to.getTime() - from.getTime()) / 86400000;
    if (span <= 0) throw new TypeError("to must be after from");
    if (span > MAX_AVAILABILITY_SPAN_DAYS) {
      throw new TypeError(
        `the range can cover at most ${MAX_AVAILABILITY_SPAN_DAYS} nights`,
      );
    }
    const rows = await model
      .find({ date: { $gte: from, $lt: to } }, { listing: 1, holdExpiresAt: 1 })
      .lean();
    const ids = new Map();
    for (const row of rows) {
      if (!isStale(row, now)) ids.set(String(row.listing), row.listing);
    }
    return [...ids.values()];
  }

  return {
    reserveNights,
    releaseNights,
    availableRanges,
    nightsInRange,
    releaseBlockedNights,
    hasUpcomingReservation,
    unavailableListingIds,
  };
}

function nightsOf(a, b) {
  return (b.getTime() - a.getTime()) / 86400000;
}

module.exports = {
  ...createLedgerService(),
  createLedgerService,
  isDuplicateKeyError,
  MAX_NIGHTS_PER_CALL,
};
