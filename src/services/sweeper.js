// Sweeper (P07-T07): the housekeeping that keeps reservations, the night
// ledger and the listings tidy. One pass (`runOnce`) does four things, in this
// order, and a failure in one never stops the next:
//
//   1. expire    pending reservations whose hold ran out   (-> "expired", nights released)
//   2. complete  confirmed reservations whose check-out date has passed in the
//                listing's own time zone                     (-> "completed")
//   3. orphans   ledger rows whose reservation is missing or has released its
//                nights, and block rows with no block record (deleted)
//   4. drafts    listing drafts untouched for 90 days (src/services/drafts.js)
//
// Safe on several instances at once. Steps 1 and 2 go through
// reservations.transition(), a compare-and-set: when two instances try the same
// reservation, one wins and the other gets a 409 that is counted as "skipped",
// not as an error. Step 3 deletes by row _id and re-running it deletes nothing;
// step 4 re-checks each draft in its own delete. Nothing here needs a lock.
//
// Why orphan rows get a grace period: booking inserts the ledger rows FIRST and
// the reservation (or block record) a moment later (ADR-004). A row without an
// owner is therefore normal for a few milliseconds. Only rows older than
// `orphanGraceMs` (default 10 minutes) are judged.
//
// The clock is injectable (`runOnce({ now })`), so tests move time instead of
// waiting. Application code makes dates from values only in src/utils/dates.js
// (tests/unit/noUserDate.test.js), hence `shift()` below.
const { AppError } = require("../utils/errors");
const { DEFAULT_TIMEZONE, todayIn } = require("../utils/dates");
const { holdsNights } = require("./stateMachine");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const DEFAULTS = Object.freeze({
  batchSize: 200, // reservations handled per page
  maxBatches: 5, // pages per step per run (backlog continues next minute)
  orphanGraceMs: 10 * MINUTE_MS, // a ledger row must be this old to be judged
  orphanScanRows: 1000, // ledger rows examined per run (a rolling window)
  draftsEveryMs: HOUR_MS, // the draft clean-up runs at most this often
  draftDays: 90,
});

// The calendar is ahead of UTC by at most 14 hours (Pacific/Kiritimati). So no
// stay can be over anywhere while its check-out is after "today" there: that
// date narrows the database query, and the exact test is made per reservation
// in its own zone.
const LATEST_ZONE = "Pacific/Kiritimati";

/** `now` moved by `ms`, without handing a value to the Date constructor. */
function shift(now, ms) {
  const moved = new Date();
  moved.setTime(now.getTime() + ms);
  return moved;
}

/** A 409 from a transition means another instance (or a user) got there first. */
const lostRace = (err) => err instanceof AppError && err.statusCode === 409;

const describeError = (err) =>
  err && err.message ? String(err.message) : String(err);

/**
 * @param {object} [deps] replaceable in unit tests; the defaults load the real
 *   models and services only when called, so requiring this file has no
 *   side effects
 */
function createSweeper({
  ReservationModel = require("../models/reservation"),
  StayNightModel = require("../models/stayNight"),
  AvailabilityBlockModel = require("../models/availabilityBlock"),
  ListingModel = require("../models/listing"),
  reservationService = require("./reservations"),
  deleteStaleDrafts = require("./drafts").deleteStaleDrafts,
  destroyImage,
  logger,
  options = {},
} = {}) {
  const settings = { ...DEFAULTS, ...options };
  const log = logger || { info() {}, warn() {}, error() {} };
  const destroy =
    destroyImage ||
    ((publicId) => require("../config/cloudinary").deleteImage(publicId, log));

  let orphanCursor = null; // where the next orphan scan resumes (per instance)
  let lastDraftRun = null; // when the draft clean-up last ran (per instance)

  /**
   * Walks the matching reservations in _id order, `batchSize` at a time, and
   * calls `handle` for each. Paging by _id (not by "the first N that match")
   * means a reservation that cannot be handled right now never hides the ones
   * behind it.
   */
  async function forEachReservation(filter, projection, handle) {
    let after = null;
    for (let page = 0; page < settings.maxBatches; page += 1) {
      const rows = await ReservationModel.find(
        after ? { ...filter, _id: { $gt: after } } : filter,
      )
        .sort({ _id: 1 })
        .limit(settings.batchSize)
        .select(projection)
        .lean();
      for (const row of rows) await handle(row);
      if (rows.length < settings.batchSize) return;
      after = rows[rows.length - 1]._id;
    }
  }

  async function expirePending(now, summary) {
    await forEachReservation(
      { status: "pending", holdExpiresAt: { $lt: now } },
      "_id",
      async (row) => {
        try {
          await reservationService.transition(row._id, "expired", {
            actor: "system",
            now,
            reason: "The host did not answer before the request ran out.",
          });
          summary.expired += 1;
        } catch (err) {
          if (lostRace(err)) summary.skipped += 1;
          else
            summary.errors.push({
              step: "expire",
              id: String(row._id),
              message: describeError(err),
            });
        }
      },
    );
  }

  async function completeStays(now, summary) {
    await forEachReservation(
      { status: "confirmed", checkOut: { $lte: todayIn(LATEST_ZONE, now) } },
      "_id checkOut listingSnapshot.timezone",
      async (row) => {
        const zone =
          (row.listingSnapshot && row.listingSnapshot.timezone) ||
          DEFAULT_TIMEZONE;
        try {
          // Still the last night in this zone: leave it for a later pass.
          if (row.checkOut.getTime() > todayIn(zone, now).getTime()) return;
          await reservationService.transition(row._id, "completed", {
            actor: "system",
            now,
            reason: "The stay is over.",
          });
          summary.completed += 1;
        } catch (err) {
          if (lostRace(err)) summary.skipped += 1;
          else
            summary.errors.push({
              step: "complete",
              id: String(row._id),
              message: describeError(err),
            });
        }
      },
    );
  }

  // Ids (as strings) of the sources that still own their ledger rows.
  async function liveSources(kind, ids) {
    if (ids.length === 0) return new Set();
    if (kind === "block") {
      const blocks = await AvailabilityBlockModel.find({ _id: { $in: ids } })
        .select("_id")
        .lean();
      return new Set(blocks.map((b) => String(b._id)));
    }
    const reservations = await ReservationModel.find({ _id: { $in: ids } })
      .select("_id status")
      .lean();
    return new Set(
      reservations
        .filter((r) => holdsNights(r.status))
        .map((r) => String(r._id)),
    );
  }

  async function removeOrphanNights(now, summary) {
    const cutoff = shift(now, -settings.orphanGraceMs);
    const rows = await StayNightModel.find(
      orphanCursor ? { _id: { $gt: orphanCursor } } : {},
    )
      .sort({ _id: 1 })
      .limit(settings.orphanScanRows)
      .select("_id source createdAt")
      .lean();
    // A short page means the end of the collection: start over next time.
    orphanCursor =
      rows.length < settings.orphanScanRows ? null : rows[rows.length - 1]._id;

    // Too young to judge (its owner may still be being written).
    const old = rows.filter(
      (row) => !row.createdAt || row.createdAt.getTime() < cutoff.getTime(),
    );
    const idsByKind = { reservation: new Set(), block: new Set() };
    for (const row of old) {
      if (row.source && idsByKind[row.source.kind])
        idsByKind[row.source.kind].add(String(row.source.id));
    }

    const live = {};
    for (const kind of Object.keys(idsByKind)) {
      live[kind] = await liveSources(kind, [...idsByKind[kind]]);
    }

    const orphanRowIds = old
      .filter(
        (row) =>
          row.source &&
          live[row.source.kind] &&
          !live[row.source.kind].has(String(row.source.id)),
      )
      .map((row) => row._id);
    if (orphanRowIds.length === 0) return;

    const result = await StayNightModel.deleteMany({
      _id: { $in: orphanRowIds },
    });
    summary.orphanNights += (result && result.deletedCount) || 0;
  }

  async function removeStaleDrafts(now, summary, force) {
    if (
      !force &&
      lastDraftRun &&
      now.getTime() - lastDraftRun.getTime() < settings.draftsEveryMs
    )
      return;
    const result = await deleteStaleDrafts(ListingModel, {
      now,
      days: settings.draftDays,
      destroy,
    });
    lastDraftRun = now;
    summary.staleDrafts += (result && result.deleted) || 0;
  }

  /**
   * One pass. Never throws: problems are returned in `errors`.
   * @param {{ now?: Date, drafts?: boolean }} [run] `drafts: true` forces the
   *   draft clean-up even if it ran recently
   * @returns {Promise<{ at: Date, expired: number, completed: number,
   *   orphanNights: number, staleDrafts: number, skipped: number,
   *   errors: Array<{ step: string, id?: string, message: string }> }>}
   */
  async function runOnce({ now = new Date(), drafts = false } = {}) {
    const summary = {
      at: now,
      expired: 0,
      completed: 0,
      orphanNights: 0,
      staleDrafts: 0,
      skipped: 0,
      errors: [],
    };
    const steps = [
      ["expire", () => expirePending(now, summary)],
      ["complete", () => completeStays(now, summary)],
      ["orphans", () => removeOrphanNights(now, summary)],
      ["drafts", () => removeStaleDrafts(now, summary, drafts)],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (err) {
        summary.errors.push({ step: name, message: describeError(err) });
      }
    }
    return summary;
  }

  return { runOnce };
}

/**
 * Runs `runOnce` now and then every `intervalMs`. A pass that is still running
 * when the next tick arrives makes that tick a no-op (no overlapping passes in
 * one process). The timer does not keep the process alive.
 * @returns {{ stop: () => void, tick: () => Promise<void> }}
 */
function startSweeper({
  runOnce,
  intervalMs = MINUTE_MS,
  logger,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const log = logger || { info() {}, warn() {}, error() {} };
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const s = await runOnce();
      const worked = s.expired + s.completed + s.orphanNights + s.staleDrafts;
      if (worked > 0) {
        log.info(
          {
            expired: s.expired,
            completed: s.completed,
            orphanNights: s.orphanNights,
            staleDrafts: s.staleDrafts,
            skipped: s.skipped,
          },
          "sweeper pass",
        );
      }
      for (const problem of s.errors)
        log.error({ sweeper: problem }, "sweeper step failed");
    } catch (err) {
      log.error({ err }, "sweeper pass crashed");
    } finally {
      running = false;
    }
  }

  const timer = setIntervalFn(tick, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  tick(); // catch up straight away after a restart
  return { stop: () => clearIntervalFn(timer), tick };
}

module.exports = { createSweeper, startSweeper, shift, DEFAULTS };
