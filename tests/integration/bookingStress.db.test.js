// P07-T08 against a real MongoDB: the same randomised run as
// tests/unit/bookingStress.test.js, but the operations of a wave really race
// (unique night index, compare-and-set transitions, parallel sweeper passes).
// Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/bookingStress.db.test.js
//   STRESS_SEED=42 npm test -- tests/integration/bookingStress.db.test.js   (repeat one run)
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const { checkDatabase } = require("../helpers/invariants");
const { runStress } = require("../helpers/bookingStress");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const reservations = require("../../src/services/reservations");
const { createSweeper } = require("../../src/services/sweeper");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const SEEDS = process.env.STRESS_SEED
  ? [Number(process.env.STRESS_SEED)]
  : [11, 12];
const TIMEOUT = 5 * 60 * 1000;

describeDb("randomised booking operations (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Promise.all([Reservation.init(), StayNight.init()]);
  });

  async function buildWorld() {
    const { user: host } = await createUser();
    const guests = [];
    for (let i = 0; i < 5; i += 1) guests.push((await createUser()).user);
    const listings = [
      await createListing({
        owner: host,
        instantBook: true,
        capacity: { guests: 4 },
        timezone: "Asia/Kolkata",
      }),
      await createListing({
        owner: host,
        instantBook: false,
        capacity: { guests: 4 },
        timezone: "Asia/Kolkata",
      }),
    ];
    // Inside a wave the sweeper must not judge ledger rows by age (a booking
    // inserts its nights before its reservation); after the wave a strict
    // one looks at everything.
    const inWave = createSweeper({
      options: { orphanGraceMs: 10 * 365 * 24 * 60 * 60 * 1000 },
    });
    const strict = createSweeper({ options: { orphanGraceMs: 0 } });
    return {
      listings,
      guests,
      timezone: "Asia/Kolkata",
      start: new Date(),
      create: (input, { now }) => reservations.create(input, { now }),
      transition: (id, to, opts) => reservations.transition(id, to, opts),
      sweep: (now) => inWave.runOnce({ now }),
      sweepAfterWave: (now) => strict.runOnce({ now }),
      snapshot: async () => {
        const [reservationRows, nights] = await Promise.all([
          Reservation.find({}).lean(),
          StayNight.find({}).lean(),
        ]);
        return { reservations: reservationRows, nights };
      },
    };
  }

  test.each(SEEDS)(
    "seed %i: 1,000 operations, zero invariant violations",
    async (seed) => {
      const world = await buildWorld();
      const { stats, problems, log } = await runStress({
        seed,
        operations: 1000,
        world,
      });
      if (problems.length > 0) {
        throw new Error(
          `${problems.slice(0, 5).join("\n")}\n\nlast waves:\n${log.slice(-5).join("\n")}\nre-run: STRESS_SEED=${seed}`,
        );
      }
      expect(stats.operations).toBe(1000);
      expect(stats.created).toBeGreaterThan(80);
      expect(stats.nightsTaken).toBeGreaterThan(20);
      expect(await checkDatabase()).toEqual([]);
    },
    TIMEOUT,
  );

  test("20 guests ask for the same nights at once: exactly one gets them", async () => {
    const world = await buildWorld();
    const today = todayIn("Asia/Kolkata");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reservations
          .create({
            guest: world.guests[i % world.guests.length],
            listing: world.listings[0]._id,
            in: formatDateOnly(addDays(today, 6)),
            out: formatDateOnly(addDays(today, 9)),
            guests: 2,
            idempotencyKey: `db-clash-${i}-abcdefghij`,
          })
          .then(
            (r) => ({ ok: r }),
            (e) => ({ err: e }),
          ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => x.err))
      expect(r.err.code).toBe("nights_unavailable");
    expect(await StayNight.countDocuments({})).toBe(3);
    expect(await Reservation.countDocuments({})).toBe(1);
    expect(await checkDatabase()).toEqual([]);
  });
});
