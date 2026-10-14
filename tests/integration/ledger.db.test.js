// P07-T02: the StayNight ledger against a real MongoDB. This is the feasibility
// gate for the booking design (ADR-004): the unique (listing, date) index must
// give "exactly one winner" under truly concurrent requests.
//
//   npm test -- tests/integration/ledger.db.test.js
//   1..20 | ForEach-Object { npm test -- tests/integration/ledger.db.test.js }
//
// Skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const StayNight = require("../../src/models/stayNight");
const ledger = require("../../src/services/ledger");
const { ConflictError } = require("../../src/utils/errors");
const { parseDateOnly, addDays } = require("../../src/utils/dates");

const d = (s) => parseDateOnly(s);
const range = (start, count) =>
  Array.from({ length: count }, (_, i) => addDays(d(start), i));
const oid = () => new mongoose.Types.ObjectId();
const reservation = () => ({ kind: "reservation", id: oid() });
const block = () => ({ kind: "block", id: oid() });
const heldBy = (sourceId) => StayNight.countDocuments({ "source.id": sourceId });
const settled = (promises) => Promise.allSettled(promises);
const fulfilled = (results) => results.filter((r) => r.status === "fulfilled");
const rejected = (results) => results.filter((r) => r.status === "rejected");

describeDb("night ledger (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await StayNight.init(); // make sure the unique index exists before racing
    await StayNight.deleteMany({});
  });

  test("the unique (listing, date) index exists", async () => {
    const indexes = await StayNight.collection.indexes();
    const guard = indexes.find(
      (i) => i.key.listing === 1 && i.key.date === 1 && i.unique === true,
    );
    expect(guard).toBeDefined();
  });

  test("the database itself refuses a second owner of a night", async () => {
    const listing = oid();
    const row = (id) => ({
      listing,
      date: d("2026-11-01"),
      source: { kind: "block", id },
    });
    await StayNight.create(row(oid()));
    await expect(StayNight.create(row(oid()))).rejects.toMatchObject({
      code: 11000,
    });
  });

  test("the model rejects a date that is not date-only", async () => {
    await expect(
      StayNight.create({
        listing: oid(),
        date: new Date("2026-11-01T05:00:00Z"),
        source: block(),
      }),
    ).rejects.toThrow(/date-only/);
  });

  test("reserves nights and stores source and hold", async () => {
    const listing = oid();
    const source = reservation();
    const hold = new Date(Date.now() + 3600 * 1000);
    const result = await ledger.reserveNights(
      listing,
      range("2026-11-01", 3),
      source,
      hold,
    );
    expect(result.reserved).toBe(3);

    const rows = await StayNight.find({ listing }).sort({ date: 1 }).lean();
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(rows[0].source.kind).toBe("reservation");
    expect(String(rows[0].source.id)).toBe(String(source.id));
    expect(rows[0].holdExpiresAt.getTime()).toBe(hold.getTime());
  });

  test("50 parallel requests for the same nights: exactly one wins (3 rounds)", async () => {
    for (let round = 0; round < 3; round += 1) {
      const listing = oid();
      const nights = range("2026-12-24", 3);
      const sources = Array.from({ length: 50 }, reservation);
      const results = await settled(
        sources.map((s) => ledger.reserveNights(listing, nights, s)),
      );

      expect(fulfilled(results)).toHaveLength(1);
      expect(rejected(results)).toHaveLength(49);
      expect(
        rejected(results).every((r) => r.reason instanceof ConflictError),
      ).toBe(true);

      const rows = await StayNight.find({ listing }).lean();
      expect(rows).toHaveLength(3);
      const winner = sources[results.findIndex((r) => r.status === "fulfilled")];
      expect(rows.every((r) => String(r.source.id) === String(winner.id))).toBe(
        true,
      );
    }
  });

  test("overlapping partial ranges: never both, winners hold everything, losers hold nothing", async () => {
    for (let round = 0; round < 25; round += 1) {
      const listing = oid();
      const a = reservation();
      const b = reservation();
      const [ra, rb] = await settled([
        ledger.reserveNights(listing, range("2026-12-01", 5), a), // 1..5
        ledger.reserveNights(listing, range("2026-12-04", 5), b), // 4..8
      ]);
      expect(fulfilled([ra, rb])).toHaveLength(1);
      expect(await heldBy(a.id)).toBe(ra.status === "fulfilled" ? 5 : 0);
      expect(await heldBy(b.id)).toBe(rb.status === "fulfilled" ? 5 : 0);
    }
  });

  test("many random overlapping requests: all-or-nothing, no night owned twice", async () => {
    let seed = 11;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const listing = oid();
    const days = range("2027-01-01", 40);
    const attempts = Array.from({ length: 60 }, () => {
      const start = rand(30);
      return {
        source: reservation(),
        nights: days.slice(start, start + 1 + rand(6)),
      };
    });
    const results = await settled(
      attempts.map(({ source, nights }) =>
        ledger.reserveNights(listing, nights, source),
      ),
    );
    let total = 0;
    for (let i = 0; i < attempts.length; i += 1) {
      const held = await heldBy(attempts[i].source.id);
      if (results[i].status === "fulfilled") {
        expect(held).toBe(attempts[i].nights.length);
        total += held;
      } else {
        expect(results[i].reason).toBeInstanceOf(ConflictError);
        expect(held).toBe(0);
      }
    }
    expect(await StayNight.countDocuments({ listing })).toBe(total);
  });

  test("disjoint stays and other listings do not interfere", async () => {
    const listing = oid();
    const results = await settled([
      ledger.reserveNights(listing, range("2026-11-01", 3), reservation()),
      ledger.reserveNights(listing, range("2026-11-04", 3), reservation()), // touches, no overlap
      ledger.reserveNights(oid(), range("2026-11-01", 3), reservation()),
    ]);
    expect(fulfilled(results)).toHaveLength(3);
    expect(await StayNight.countDocuments({})).toBe(9);
  });

  test("a collision rolls back the nights inserted before it", async () => {
    const listing = oid();
    const blocker = block();
    await ledger.reserveNights(listing, [d("2026-11-04")], blocker);

    let error;
    try {
      await ledger.reserveNights(listing, range("2026-11-02", 5), reservation());
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("nights_unavailable");
    expect(error.conflictingDates.map((x) => x.getTime())).toEqual([
      d("2026-11-04").getTime(),
    ]);
    expect(await StayNight.countDocuments({ listing })).toBe(1);
    expect(await heldBy(blocker.id)).toBe(1);
  });

  test("re-reserving with the same source never deletes the rows it holds", async () => {
    const listing = oid();
    const source = reservation();
    const nights = range("2026-11-01", 3);
    await ledger.reserveNights(listing, nights, source);
    await expect(
      ledger.reserveNights(listing, nights, source),
    ).rejects.toThrow(ConflictError);
    expect(await heldBy(source.id)).toBe(3);
  });

  describe("expired holds", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const expired = new Date("2026-11-10T11:00:00Z");
    const seedHold = async (listing, nights, holdExpiresAt) => {
      const source = reservation();
      await StayNight.insertMany(
        nights.map((date) => ({ listing, date, source, holdExpiresAt })),
      );
      return source;
    };

    test("an expired hold is taken over, only on the nights requested", async () => {
      const listing = oid();
      const stale = await seedHold(listing, range("2026-12-01", 3), expired);
      const taker = reservation();
      const result = await ledger.reserveNights(
        listing,
        range("2026-12-02", 3),
        taker,
        null,
        { now },
      );
      expect(result.reserved).toBe(3);
      expect(await heldBy(taker.id)).toBe(3);
      expect(await heldBy(stale.id)).toBe(1); // 12-01 was not asked for
    });

    test("a live hold or a confirmed reservation is never taken over", async () => {
      const listing = oid();
      const live = await seedHold(
        listing,
        range("2026-12-01", 2),
        new Date("2026-11-10T13:00:00Z"),
      );
      await expect(
        ledger.reserveNights(listing, range("2026-12-01", 2), reservation(), null, {
          now,
        }),
      ).rejects.toThrow(ConflictError);
      expect(await heldBy(live.id)).toBe(2);

      const confirmed = reservation();
      await ledger.reserveNights(listing, range("2026-12-10", 2), confirmed);
      await expect(
        ledger.reserveNights(listing, range("2026-12-10", 2), reservation(), null, {
          now: new Date("2030-01-01T00:00:00Z"),
        }),
      ).rejects.toThrow(ConflictError);
      expect(await heldBy(confirmed.id)).toBe(2);
    });

    test("20 parallel takers of one expired hold: exactly one wins", async () => {
      const listing = oid();
      await seedHold(listing, range("2026-12-01", 3), expired);
      const results = await settled(
        Array.from({ length: 20 }, () =>
          ledger.reserveNights(listing, range("2026-12-01", 3), reservation(), null, {
            now,
          }),
        ),
      );
      expect(fulfilled(results)).toHaveLength(1);
      expect(await StayNight.countDocuments({ listing })).toBe(3);
      expect(
        (await StayNight.distinct("source.id", { listing })).length,
      ).toBe(1);
    });
  });

  test("release frees one source's nights and is idempotent", async () => {
    const listing = oid();
    const a = reservation();
    const b = block();
    await ledger.reserveNights(listing, range("2026-11-01", 3), a);
    await ledger.reserveNights(listing, range("2026-11-10", 2), b);

    expect(await ledger.releaseNights(a.id)).toEqual({ released: 3 });
    expect(await ledger.releaseNights(a.id)).toEqual({ released: 0 });
    expect(await ledger.releaseNights(oid())).toEqual({ released: 0 });
    expect(await heldBy(b.id)).toBe(2);

    await ledger.reserveNights(listing, range("2026-11-01", 3), reservation());
    expect(await StayNight.countDocuments({ listing })).toBe(5);
  });

  test("availableRanges reflects holds, blocks and expired holds", async () => {
    const listing = oid();
    const now = new Date("2026-11-10T12:00:00Z");
    await ledger.reserveNights(listing, [d("2026-12-03")], reservation());
    await ledger.reserveNights(listing, range("2026-12-06", 2), block());
    await StayNight.create({
      listing,
      date: d("2026-12-09"),
      source: reservation(),
      holdExpiresAt: new Date("2026-11-10T11:00:00Z"), // expired: free
    });

    const ranges = await ledger.availableRanges(
      listing,
      d("2026-12-01"),
      d("2026-12-10"),
      { now },
    );
    expect(
      ranges.map((r) => [
        r.from.toISOString().slice(0, 10),
        r.to.toISOString().slice(0, 10),
        r.nights,
      ]),
    ).toEqual([
      ["2026-12-01", "2026-12-03", 2],
      ["2026-12-04", "2026-12-06", 2],
      ["2026-12-08", "2026-12-10", 2],
    ]);
  });
});
