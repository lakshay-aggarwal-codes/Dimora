// Randomised booking stress (P07-T08). One runner, two worlds: in-memory fakes
// (tests/unit/bookingStress.test.js, no mongod) and a real MongoDB with real
// concurrency (tests/integration/bookingStress.db.test.js).
//
// A run is a series of "waves". In a wave 1-8 operations start at the same
// moment (Promise.all) on a clock that only the runner moves: create a
// booking (instant-book and request listings, heavily overlapping dates),
// replay an earlier booking's idempotency key, accept, decline, cancel as guest
// or host (often on a reservation another operation in the same wave is also
// changing), and run the sweeper (expires holds, completes finished stays).
// Time jumps forward between waves, sometimes by days.
//
// Checked, with zero tolerance:
//   after every wave, BEFORE the sweeper: a night never has two owners (a);
//     no ledger row belongs to a reservation that released its nights, or to
//     none (c); every reservation whose hold is still live is consistent
//     (b, d). A request whose hold ran out is the only thing allowed to be
//     out of step: the sweeper has not looked at it yet.
//   after the sweeper: every invariant in tests/helpers/invariants.js for
//     every reservation, and the sweeper found no orphan ledger rows to
//     delete (it must never be what makes the data consistent);
//   independently of the ledger: two reservations that hold nights never
//     overlap on one listing.
//   replaying a key gives back the same reservation;
//   the only errors are the service's own 4xx; anything else fails the run.
const { findViolations } = require("./invariants");
const { holdsNights } = require("../../src/services/stateMachine");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const idOf = (v) => String(v && v._id ? v._id : v);

/** Small seeded generator (mulberry32): the same seed repeats the same run. */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  const weighted = (table) => {
    const total = table.reduce((sum, [, w]) => sum + w, 0);
    let roll = next() * total;
    for (const [value, w] of table) {
      roll -= w;
      if (roll < 0) return value;
    }
    return table[table.length - 1][0];
  };
  return { next, int, pick, weighted };
}

const OPERATIONS = [
  ["create", 48],
  ["replay", 6],
  ["accept", 12],
  ["decline", 6],
  ["guest_cancel", 9],
  ["host_cancel", 5],
  ["sweep", 8],
  ["fresh_clash", 6], // creates that deliberately target one night together
];

const TARGETS = {
  accept: { to: "confirmed", actor: "host", from: ["pending"] },
  decline: { to: "declined", actor: "host", from: ["pending"] },
  guest_cancel: {
    to: "cancelled_by_guest",
    actor: "guest",
    from: ["pending", "confirmed"],
  },
  host_cancel: { to: "cancelled_by_host", actor: "host", from: ["confirmed"] },
};

/**
 * @param {object} options
 * @param {number} options.seed
 * @param {number} options.operations  how many create/transition/sweep operations to run
 * @param {object} options.world
 *   world.listings   [{ _id }]            (booking inputs use the listing's own zone)
 *   world.guests     [guest objects]
 *   world.timezone   "Asia/Kolkata"
 *   world.start      Date                 the clock at the start
 *   world.create(input, { now })          reservations.create
 *   world.transition(id, to, opts)        reservations.transition
 *   world.sweep(now)                      -> the sweeper's summary (also run inside waves)
 *   world.sweepAfterWave(now)             optional: the sweeper run once a wave is over
 *                                         (a database world uses a strict orphan check here)
 *   world.snapshot()                      -> { reservations, nights } (plain rows)
 * @returns {Promise<{ stats: object, problems: string[], log: string[] }>}
 */
async function runStress({ seed, operations, world }) {
  const rng = prng(seed);
  const problems = [];
  const log = [];
  const stats = {
    operations: 0,
    waves: 0,
    created: 0,
    replays: 0,
    transitions: 0,
    sweeps: 0,
    refused: 0,
    nightsTaken: 0,
    expiredBySweeper: 0,
    completedBySweeper: 0,
    orphansFound: 0,
  };
  const issued = []; // { guestIndex, input, reservationId? }
  let clock = world.start;
  let keyN = 0;
  const fail = (message) => {
    problems.push(`seed ${seed}, wave ${stats.waves}: ${message}`);
  };

  /** Refusals the service is allowed to give; everything else is a bug. */
  const settle = async (label, run) => {
    try {
      return await run();
    } catch (err) {
      if (
        err &&
        Number.isInteger(err.statusCode) &&
        err.statusCode >= 400 &&
        err.statusCode < 500
      ) {
        stats.refused += 1;
        if (err.code === "nights_unavailable") stats.nightsTaken += 1;
        return { refused: err.code || err.statusCode };
      }
      fail(`${label} threw ${err && err.name}: ${err && err.message}`);
      return { crashed: true };
    }
  };

  const stay = () => {
    const today = todayIn(world.timezone, clock);
    const offset = rng.int(1, 9);
    const nights = rng.int(1, 3);
    return {
      in: formatDateOnly(addDays(today, offset)),
      out: formatDateOnly(addDays(today, offset + nights)),
    };
  };

  const createInput = (guestIndex, listing, dates) => ({
    guest: world.guests[guestIndex],
    listing: listing._id,
    ...dates,
    guests: rng.int(1, 2),
    idempotencyKey: `stress-${seed}-${(keyN += 1)}-abcdefghij`,
  });

  const doCreate = (input, guestIndex, now) => async () => {
    const entry = { guestIndex, input };
    issued.push(entry);
    const result = await settle("create", () => world.create(input, { now }));
    if (result.reservation) {
      stats.created += result.created ? 1 : 0;
      entry.reservationId = idOf(result.reservation);
    }
  };

  const doReplay = (now) => async () => {
    const known = issued.filter((e) => e.reservationId);
    if (known.length === 0) return;
    const entry = rng.pick(known);
    stats.replays += 1;
    const result = await settle("replay", () =>
      world.create(entry.input, { now }),
    );
    if (
      result.reservation &&
      idOf(result.reservation) !== entry.reservationId
    ) {
      fail(
        `replaying a key returned reservation ${idOf(result.reservation)}, not ${entry.reservationId}`,
      );
    }
    if (result.reservation && result.created)
      fail("a replayed key created a second reservation");
  };

  const doTransition = (kind, reservations, now) => async () => {
    const target = TARGETS[kind];
    // Prefer a reservation in a state the move is allowed from, but sometimes
    // aim at any, to see the refusal.
    const fits = reservations.filter((r) => target.from.includes(r.status));
    const pool = fits.length > 0 && rng.next() < 0.85 ? fits : reservations;
    if (pool.length === 0) return;
    const reservation = rng.pick(pool);
    stats.transitions += 1;
    await settle(kind, () =>
      world.transition(reservation._id, target.to, {
        actor: target.actor,
        now,
      }),
    );
  };

  while (stats.operations < operations) {
    stats.waves += 1;
    // Time only moves forward: usually hours, sometimes whole days.
    clock = new Date(
      clock.getTime() +
        (rng.next() < 0.12 ? rng.int(1, 3) * DAY : rng.int(0, 5 * HOUR)),
    );
    const now = clock;
    const before = await world.snapshot();
    const tasks = [];
    const width = rng.int(1, 8);

    for (let i = 0; i < width && stats.operations < operations; i += 1) {
      stats.operations += 1;
      const kind = rng.weighted(OPERATIONS);
      if (kind === "create") {
        const guestIndex = rng.int(0, world.guests.length - 1);
        tasks.push(
          doCreate(
            createInput(guestIndex, rng.pick(world.listings), stay()),
            guestIndex,
            now,
          ),
        );
      } else if (kind === "fresh_clash") {
        // Three guests ask for the very same nights at the same moment.
        const listing = rng.pick(world.listings);
        const dates = stay();
        for (let g = 0; g < 3; g += 1) {
          const guestIndex = rng.int(0, world.guests.length - 1);
          tasks.push(
            doCreate(createInput(guestIndex, listing, dates), guestIndex, now),
          );
        }
      } else if (kind === "replay") {
        tasks.push(doReplay(now));
      } else if (kind === "sweep") {
        stats.sweeps += 1;
        tasks.push(async () => {
          await settle("sweep", () => world.sweep(now));
        });
      } else {
        tasks.push(doTransition(kind, before.reservations, now));
        // Often a second, competing change to the same reservation.
        if (rng.next() < 0.4) {
          const rival = rng.weighted([
            ["guest_cancel", 3],
            ["accept", 3],
            ["decline", 1],
            ["host_cancel", 1],
          ]);
          tasks.push(doTransition(rival, before.reservations, now));
        }
      }
    }
    await Promise.all(tasks.map((task) => task()));

    // Before the sweeper: everything except requests whose hold has run out.
    const mid = await world.snapshot();
    const stale = mid.reservations
      .filter(
        (r) =>
          r.status === "pending" &&
          r.holdExpiresAt &&
          new Date(r.holdExpiresAt) < now,
      )
      .map((r) => idOf(r));
    for (const message of findViolations(mid.reservations, mid.nights)) {
      if (!stale.some((id) => message.includes(id)))
        fail(`before the sweeper: ${message}`);
    }

    // The sweeper, then everything.
    const summary = await settle("sweep", () =>
      (world.sweepAfterWave || world.sweep)(now),
    );
    if (summary && summary.errors && summary.errors.length > 0)
      fail(`the sweeper reported ${JSON.stringify(summary.errors)}`);
    if (summary && summary.orphanNights > 0) {
      stats.orphansFound += summary.orphanNights;
      fail(
        `the sweeper had ${summary.orphanNights} orphan ledger row(s) to delete`,
      );
    }
    if (summary) {
      stats.expiredBySweeper += summary.expired || 0;
      stats.completedBySweeper += summary.completed || 0;
    }
    const after = await world.snapshot();
    for (const message of findViolations(after.reservations, after.nights))
      fail(`after the sweeper: ${message}`);
    for (const message of overlaps(after.reservations)) fail(message);
    if (problems.length > 0) break; // the first bad wave is the one worth reading
    log.push(
      `wave ${stats.waves}: ${tasks.length} task(s), ${after.reservations.length} reservation(s), ${after.nights.length} night row(s)`,
    );
  }

  const finalState = await world.snapshot();
  stats.statuses = {};
  for (const r of finalState.reservations)
    stats.statuses[r.status] = (stats.statuses[r.status] || 0) + 1;
  return { stats, problems, log };
}

/** Two reservations that hold nights must not share a night of one listing. */
function overlaps(reservations) {
  const problems = [];
  const owner = new Map();
  for (const r of reservations) {
    if (!holdsNights(r.status)) continue;
    for (
      let t = new Date(r.checkIn).getTime();
      t < new Date(r.checkOut).getTime();
      t += DAY
    ) {
      const key = `${idOf(r.listing)}|${t}`;
      if (owner.has(key))
        problems.push(
          `two reservations hold ${new Date(t).toISOString().slice(0, 10)} of listing ${idOf(r.listing)}: ${owner.get(key)} and ${idOf(r)}`,
        );
      else owner.set(key, idOf(r));
    }
  }
  return problems;
}

module.exports = { runStress, prng, overlaps };
