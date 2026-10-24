// P07-T07 against a real MongoDB: the sweeper with the real models, including
// several sweepers running at the same time. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/sweeper.db.test.js
//
// Reservations are inserted directly (this test is about the sweeper, not about
// booking); the ledger rows come from the real ledger service.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const { checkDatabase } = require("../helpers/invariants");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const AvailabilityBlock = require("../../src/models/availabilityBlock");
const Listing = require("../../src/models/listing");
const ledger = require("../../src/services/ledger");
const { createSweeper, shift } = require("../../src/services/sweeper");
const { eachNight } = require("../../src/utils/dates");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-10T06:00:00.000Z"); // 2026-11-10 in Kolkata
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
let keyN = 0;

describeDb("sweeper (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Promise.all([
      Reservation.init(),
      StayNight.init(),
      AvailabilityBlock.init(),
    ]);
  });

  const sweeper = () => createSweeper({ destroyImage: async () => true });
  const sweepAll = (n) =>
    Promise.all(
      Array.from({ length: n }, () => sweeper().runOnce({ now: T0 })),
    );

  async function world() {
    const { user: host } = await createUser();
    const { user: guest } = await createUser();
    const listing = await createListing({ owner: host });
    return { host, guest, listing };
  }

  // A reservation in `status` with the ledger rows its status calls for.
  async function reserve(
    { host, guest, listing },
    { status = "pending", checkIn, checkOut, hold },
  ) {
    const _id = new mongoose.Types.ObjectId();
    const holdExpiresAt = status === "pending" ? hold : undefined;
    const from = day(checkIn);
    const to = day(checkOut);
    const nights = eachNight(from, to);
    // Rows are inserted with the real service, which refuses a hold in the
    // past: write the hold on afterwards when the test wants an expired one.
    await ledger.reserveNights(
      listing._id,
      nights,
      { kind: "reservation", id: _id },
      holdExpiresAt ? shift(T0, 60 * 60 * 1000) : null,
      { now: T0 },
    );
    if (holdExpiresAt)
      await StayNight.updateMany(
        { "source.id": _id },
        { $set: { holdExpiresAt } },
      );
    return Reservation.create({
      _id,
      listing: listing._id,
      guest: guest._id,
      host: host._id,
      checkIn: from,
      checkOut: to,
      nights: nights.length,
      guests: 2,
      status,
      ...(holdExpiresAt ? { holdExpiresAt } : {}),
      statusHistory: [
        { from: null, to: status, at: shift(T0, -2 * DAY), actor: "guest" },
      ],
      pricingSnapshot: { totalMinor: 100000, currency: "INR" },
      listingSnapshot: { timezone: "Asia/Kolkata" },
      idempotencyKey: `sweep-key-${(keyN += 1)}-abcdefgh`,
    });
  }

  const expectConsistent = async () =>
    expect(await checkDatabase()).toEqual([]);

  test("the sweeper's indexes exist", async () => {
    const keys = (await Reservation.collection.indexes()).map((i) =>
      Object.keys(i.key).join(","),
    );
    expect(keys).toEqual(
      expect.arrayContaining(["status,holdExpiresAt", "status,checkOut"]),
    );
  });

  test("an unanswered request is expired and its nights are freed", async () => {
    const w = await world();
    const r = await reserve(w, {
      checkIn: "2026-12-01",
      checkOut: "2026-12-04",
      hold: shift(T0, -HOUR),
    });
    const result = await sweeper().runOnce({ now: T0 });
    expect(result.errors).toEqual([]);
    expect(result.expired).toBe(1);
    const after = await Reservation.findById(r._id).lean();
    expect(after.status).toBe("expired");
    expect(after.holdExpiresAt).toBeUndefined();
    expect(after.statusHistory.map((h) => h.to)).toEqual([
      "pending",
      "expired",
    ]);
    expect(await StayNight.countDocuments()).toBe(0);
    await expectConsistent();
  });

  test("a request still inside its hold is left alone", async () => {
    const w = await world();
    const r = await reserve(w, {
      checkIn: "2026-12-01",
      checkOut: "2026-12-04",
      hold: shift(T0, HOUR),
    });
    expect((await sweeper().runOnce({ now: T0 })).expired).toBe(0);
    expect((await Reservation.findById(r._id)).status).toBe("pending");
    expect(await StayNight.countDocuments()).toBe(3);
    await expectConsistent();
  });

  test("8 sweepers at once: the request expires exactly once, nobody reports an error", async () => {
    const w = await world();
    const r = await reserve(w, {
      checkIn: "2026-12-01",
      checkOut: "2026-12-04",
      hold: shift(T0, -HOUR),
    });
    const results = await sweepAll(8);
    expect(results.reduce((n, x) => n + x.expired, 0)).toBe(1);
    expect(results.flatMap((x) => x.errors)).toEqual([]);
    const after = await Reservation.findById(r._id).lean();
    expect(after.statusHistory.filter((h) => h.to === "expired")).toHaveLength(
      1,
    );
    await expectConsistent();
  });

  test("a stay is completed once check-out has passed in its zone; its past nights stay", async () => {
    const w = await world();
    const over = await reserve(w, {
      status: "confirmed",
      checkIn: "2026-11-07",
      checkOut: "2026-11-10",
    });
    // A different night: two stays cannot hold the same night of one listing.
    const notYet = await reserve(w, {
      status: "confirmed",
      checkIn: "2026-11-10",
      checkOut: "2026-11-11",
    });
    const result = await sweeper().runOnce({ now: T0 });
    expect(result.completed).toBe(1);
    expect((await Reservation.findById(over._id)).status).toBe("completed");
    expect((await Reservation.findById(notYet._id)).status).toBe("confirmed");
    expect(await StayNight.countDocuments({ "source.id": over._id })).toBe(3);
    await expectConsistent();
    // the next morning the second one is over too
    expect((await sweeper().runOnce({ now: shift(T0, DAY) })).completed).toBe(
      1,
    );
    await expectConsistent();
  });

  test("8 sweepers at once complete a stay once", async () => {
    const w = await world();
    const r = await reserve(w, {
      status: "confirmed",
      checkIn: "2026-11-07",
      checkOut: "2026-11-10",
    });
    const results = await sweepAll(8);
    expect(results.reduce((n, x) => n + x.completed, 0)).toBe(1);
    expect(results.flatMap((x) => x.errors)).toEqual([]);
    expect(
      (await Reservation.findById(r._id)).statusHistory.filter(
        (h) => h.to === "completed",
      ),
    ).toHaveLength(1);
  });

  test("orphan rows: a missing owner, an expired owner and a block without a record go; live owners stay", async () => {
    const w = await world();
    const old = shift(T0, -HOUR);
    const live = await reserve(w, {
      status: "confirmed",
      checkIn: "2026-12-10",
      checkOut: "2026-12-12",
    });
    const gone = await reserve(w, {
      status: "expired",
      checkIn: "2026-12-20",
      checkOut: "2026-12-22",
    });
    const block = new mongoose.Types.ObjectId();
    await AvailabilityBlock.create({
      _id: block,
      listing: w.listing._id,
      from: day("2026-12-25"),
      to: day("2026-12-27"),
    });
    await ledger.reserveNights(
      w.listing._id,
      eachNight(day("2026-12-25"), day("2026-12-27")),
      { kind: "block", id: block },
      null,
      { now: T0 },
    );
    await ledger.reserveNights(
      w.listing._id,
      [day("2026-12-30")],
      { kind: "block", id: new mongoose.Types.ObjectId() },
      null,
      { now: T0 },
    );
    await ledger.reserveNights(
      w.listing._id,
      [day("2026-12-31")],
      { kind: "reservation", id: new mongoose.Types.ObjectId() },
      null,
      { now: T0 },
    );
    await StayNight.updateMany({}, { $set: { createdAt: old } });

    const result = await sweeper().runOnce({ now: T0 });
    expect(result.errors).toEqual([]);
    // 2 rows of the expired reservation + the unowned block row + the unowned reservation row
    expect(result.orphanNights).toBe(4);
    expect(await StayNight.countDocuments({ "source.id": live._id })).toBe(2);
    expect(await StayNight.countDocuments({ "source.id": block })).toBe(2);
    expect(await StayNight.countDocuments({ "source.id": gone._id })).toBe(0);
    expect(await StayNight.countDocuments()).toBe(4);
    expect((await sweeper().runOnce({ now: T0 })).orphanNights).toBe(0);
  });

  test("a row that has only just been written is not judged", async () => {
    const w = await world();
    await ledger.reserveNights(
      w.listing._id,
      [day("2026-12-31")],
      { kind: "reservation", id: new mongoose.Types.ObjectId() },
      null,
    );
    const result = await sweeper().runOnce({ now: new Date() });
    expect(result.orphanNights).toBe(0);
    expect(await StayNight.countDocuments()).toBe(1);
  });

  test("drafts untouched for 90 days are deleted; fresh drafts and published listings are not", async () => {
    const { host } = await world();
    const staleDraft = await createListing({
      owner: host,
      status: "draft",
      title: "Old draft",
    });
    const freshDraft = await createListing({
      owner: host,
      status: "draft",
      title: "Fresh draft",
    });
    const published = await createListing({
      owner: host,
      title: "Published, old",
    });
    const longAgo = shift(T0, -91 * DAY);
    await Listing.collection.updateMany(
      { _id: { $in: [staleDraft._id, published._id] } },
      { $set: { updatedAt: longAgo } },
    );
    const result = await sweeper().runOnce({ now: T0, drafts: true });
    expect(result.errors).toEqual([]);
    expect(result.staleDrafts).toBe(1);
    expect(await Listing.exists({ _id: staleDraft._id })).toBeNull();
    expect(await Listing.exists({ _id: freshDraft._id })).not.toBeNull();
    expect(await Listing.exists({ _id: published._id })).not.toBeNull();
  });
});
