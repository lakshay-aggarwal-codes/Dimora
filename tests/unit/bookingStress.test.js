// P07-T08: randomised booking stress against in-memory fakes (no mongod).
// 1,000 operations per seed, zero invariant violations. A failing run prints
// its seed: re-run it with STRESS_SEED=<n> npx jest tests/unit/bookingStress.test.js
// The real-database version with true concurrency is
// tests/integration/bookingStress.db.test.js.
const { createReservationService } = require("../../src/services/reservations");
const { createSweeper } = require("../../src/services/sweeper");
const pricing = require("../../src/services/pricing");
const { FakeListingModel, fakeId } = require("../helpers/fakeReservationDeps");
const {
  SweeperReservationModel,
  StampedLedger,
  FakeNightModel,
  FakeBlockModel,
} = require("../helpers/fakeSweeperDeps");
const { findViolations } = require("../helpers/invariants");
const { runStress, overlaps } = require("../helpers/bookingStress");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const START = new Date("2026-11-10T06:00:00.000Z"); // 11:30 in Kolkata
const HOST = { _id: fakeId() };

function listingDoc(extra = {}) {
  return {
    _id: fakeId(),
    owner: HOST._id,
    status: "published",
    deletedAt: null,
    title: "Sea house",
    address: { city: "Goa" },
    pricing: { nightlyMinor: 250000, cleaningFeeMinor: 50000, currency: "INR" },
    capacity: { guests: 4 },
    minNights: 1,
    maxNights: 14,
    instantBook: false,
    cancellationPolicy: "moderate",
    checkInTime: "14:00",
    checkOutTime: "11:00",
    timezone: "Asia/Kolkata",
    houseRules: "No parties",
    images: [{ url: "https://img/x.jpg" }],
    ...extra,
  };
}

function buildWorld() {
  let clock = START;
  const Reservation = new SweeperReservationModel();
  const ledger = new StampedLedger(() => clock);
  const listings = [
    listingDoc({ instantBook: true }),
    listingDoc({ instantBook: false }),
  ];
  const service = createReservationService({
    ReservationModel: Reservation,
    ListingModel: new FakeListingModel(listings),
    ledgerService: ledger,
    pricing,
    newId: fakeId,
    replayRetries: 20,
    replayDelayMs: 0,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const sweeper = createSweeper({
    ReservationModel: Reservation,
    StayNightModel: new FakeNightModel(ledger),
    AvailabilityBlockModel: new FakeBlockModel(),
    ListingModel: { name: "ListingModel" },
    reservationService: service,
    deleteStaleDrafts: async () => ({ deleted: 0, photosRemoved: 0 }),
    destroyImage: async () => true,
  });
  const guests = Array.from({ length: 5 }, () => ({
    _id: fakeId(),
    status: "active",
  }));
  return {
    Reservation,
    ledger,
    listings,
    guests,
    service,
    world: {
      listings,
      guests,
      timezone: "Asia/Kolkata",
      start: START,
      create: (input, { now }) => {
        clock = now;
        return service.create(input, { now });
      },
      transition: (id, to, opts) => service.transition(id, to, opts),
      sweep: (now) => {
        clock = now;
        return sweeper.runOnce({ now });
      },
      snapshot: async () => ({
        reservations: Reservation.docs.map((d) => ({ ...d })),
        nights: ledger.rows.map((r) => ({ ...r })),
      }),
    },
  };
}

const SEEDS = process.env.STRESS_SEED
  ? [Number(process.env.STRESS_SEED)]
  : [1, 2, 3, 20260701, 987654321];

describe("randomised booking operations (fakes)", () => {
  test.each(SEEDS)(
    "seed %i: 1,000 operations, zero invariant violations",
    async (seed) => {
      const { world } = buildWorld();
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
      // The run did real work: all of these happened, not just refusals.
      expect(stats.created).toBeGreaterThan(80);
      expect(stats.nightsTaken).toBeGreaterThan(20); // the unique night index refused overlaps
      expect(stats.transitions).toBeGreaterThan(80);
      expect(stats.expiredBySweeper).toBeGreaterThan(0);
      expect(stats.completedBySweeper).toBeGreaterThan(0);
      for (const status of [
        "pending",
        "confirmed",
        "completed",
        "expired",
        "declined",
        "cancelled_by_guest",
      ]) {
        expect(stats.statuses[status] || 0).toBeGreaterThan(0);
      }
      expect(stats.orphansFound).toBe(0);
    },
  );

  test("the same seed repeats the same run", async () => {
    const run = async () => {
      const { world } = buildWorld();
      const { stats } = await runStress({ seed: 7, operations: 300, world });
      return stats;
    };
    expect(await run()).toEqual(await run());
  });
});

describe("the runner notices broken data", () => {
  // The suite is only worth something if it fails when the data is wrong.
  async function oneBooking() {
    const { world, Reservation, ledger, listings, guests, service } =
      buildWorld();
    const today = todayIn("Asia/Kolkata", START);
    const { reservation } = await service.create(
      {
        guest: guests[0],
        listing: listings[0]._id,
        in: formatDateOnly(addDays(today, 5)),
        out: formatDateOnly(addDays(today, 7)),
        guests: 2,
        idempotencyKey: "break-it-0123456789",
      },
      { now: START },
    );
    return { world, Reservation, ledger, reservation };
  }

  test("a leftover ledger row of a cancelled reservation is reported", async () => {
    const { Reservation, ledger, reservation } = await oneBooking();
    const rows = ledger.rows.map((r) => ({ ...r }));
    await Reservation.findOneAndUpdate(
      { _id: reservation._id },
      { $set: { status: "cancelled_by_guest" } },
    );
    expect(findViolations(Reservation.docs, rows).join("\n")).toMatch(/\(c\)/);
  });

  test("a missing ledger row is reported", async () => {
    const { Reservation, ledger } = await oneBooking();
    expect(
      findViolations(Reservation.docs, ledger.rows.slice(1)).join("\n"),
    ).toMatch(/\(b\)/);
  });

  test("a night owned twice is reported", async () => {
    const { Reservation, ledger } = await oneBooking();
    expect(
      findViolations(Reservation.docs, [
        ...ledger.rows,
        { ...ledger.rows[0] },
      ]).join("\n"),
    ).toMatch(/\(a\)/);
  });

  test("two reservations holding one night are reported without looking at the ledger", async () => {
    const { Reservation, reservation } = await oneBooking();
    const twin = { ...Reservation.docs[0], _id: fakeId() };
    expect(overlaps([Reservation.docs[0], twin]).join("\n")).toMatch(
      /two reservations hold/,
    );
    expect(
      overlaps([Reservation.docs[0], { ...twin, status: "declined" }]),
    ).toEqual([]);
    expect(reservation.status).toBeDefined();
  });
});

describe("parallel clashes", () => {
  test("20 guests ask for the same nights at once: exactly one gets them", async () => {
    const { world, ledger, Reservation, listings, guests, service } =
      buildWorld();
    const today = todayIn("Asia/Kolkata", START);
    const attempts = Array.from({ length: 20 }, (_, i) =>
      service
        .create(
          {
            guest: guests[i % guests.length],
            listing: listings[0]._id, // instant-book
            in: formatDateOnly(addDays(today, 4)),
            out: formatDateOnly(addDays(today, 7)),
            guests: 2,
            idempotencyKey: `clash-${i}-abcdefghij`,
          },
          { now: START },
        )
        .then(
          (r) => ({ ok: r }),
          (e) => ({ err: e }),
        ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => x.err)) {
      expect(r.err.statusCode).toBe(409);
      expect(r.err.code).toBe("nights_unavailable");
    }
    expect(ledger.rows).toHaveLength(3);
    expect(Reservation.docs).toHaveLength(1);
    expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]);
    expect(world.listings).toBeDefined();
  });

  test("accept and decline at once: one wins, the nights match the winner", async () => {
    const { ledger, Reservation, listings, guests, service } = buildWorld();
    const today = todayIn("Asia/Kolkata", START);
    const { reservation } = await service.create(
      {
        guest: guests[0],
        listing: listings[1]._id,
        in: formatDateOnly(addDays(today, 4)),
        out: formatDateOnly(addDays(today, 6)),
        guests: 2,
        idempotencyKey: "race-0123456789",
      },
      { now: START },
    );
    const settled = await Promise.allSettled([
      service.transition(reservation._id, "confirmed", {
        actor: "host",
        now: START,
      }),
      service.transition(reservation._id, "declined", {
        actor: "host",
        now: START,
      }),
      service.transition(reservation._id, "cancelled_by_guest", {
        actor: "guest",
        now: START,
      }),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled.filter((x) => x.status === "rejected"))
      expect(s.reason.statusCode).toBe(409);
    const final = Reservation.docs[0].status;
    expect(ledger.rows).toHaveLength(final === "confirmed" ? 2 : 0);
    expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]);
  });
});
