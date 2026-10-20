// P07-T05 against a real MongoDB: unique indexes, concurrency, and the
// ledger/reservation invariants. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/reservations.db.test.js
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const { checkDatabase } = require("../helpers/invariants");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const reservations = require("../../src/services/reservations");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const TODAY = todayIn();
const D = (n) => formatDateOnly(addDays(TODAY, n));
let keyN = 0;
const key = () => `db-key-${(keyN += 1)}-abcdefgh`;

describeDb("reservations (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Promise.all([Reservation.init(), StayNight.init()]);
  });

  async function world({ instantBook = false } = {}) {
    const { user: host } = await createUser();
    const { user: guest } = await createUser();
    const listing = await createListing({ owner: host, instantBook, capacity: { guests: 4 } });
    const book = (over = {}) =>
      reservations.create({ guest, listing: listing._id, in: D(10), out: D(13), guests: 2, idempotencyKey: key(), ...over });
    return { host, guest, listing, book };
  }

  const expectConsistent = async () => expect(await checkDatabase()).toEqual([]);

  test("indexes exist, including unique (guest, idempotencyKey)", async () => {
    const indexes = await Reservation.collection.indexes();
    expect(indexes.some((i) => i.key.guest === 1 && i.key.idempotencyKey === 1 && i.unique)).toBe(true);
  });

  test("pending request: reservation and nights exist together", async () => {
    const { book } = await world();
    const { reservation } = await book();
    expect(reservation.status).toBe("pending");
    expect(await StayNight.countDocuments({ "source.id": reservation._id })).toBe(3);
    await expectConsistent();
  });

  test("instant booking is confirmed with no hold", async () => {
    const { book } = await world({ instantBook: true });
    const { reservation } = await book();
    expect(reservation.status).toBe("confirmed");
    expect(await StayNight.countDocuments({ holdExpiresAt: { $exists: true } })).toBe(0);
    await expectConsistent();
  });

  test("a repeated key returns the original; a double click makes one", async () => {
    const { book } = await world();
    const k = key();
    const [a, b] = await Promise.all([book({ idempotencyKey: k }), book({ idempotencyKey: k })]);
    expect(String(a.reservation._id)).toBe(String(b.reservation._id));
    expect(await Reservation.countDocuments()).toBe(1);
    expect(await StayNight.countDocuments()).toBe(3);
    const again = await book({ idempotencyKey: k });
    expect(again.created).toBe(false);
    await expectConsistent();
  });

  test("50 guests race for the same nights: exactly one reservation", async () => {
    const { host, listing } = await world();
    const guests = await Promise.all(Array.from({ length: 50 }, () => createUser().then((r) => r.user)));
    const results = await Promise.allSettled(
      guests.map((guest) =>
        reservations.create({ guest, listing: listing._id, in: D(10), out: D(13), guests: 1, idempotencyKey: key() }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(r.reason.statusCode).toBe(409);
    }
    expect(await Reservation.countDocuments()).toBe(1);
    expect(await StayNight.countDocuments()).toBe(3);
    expect(String(host._id)).toBeDefined();
    await expectConsistent();
  });

  test("overlapping stays: the second is refused and leaves nothing", async () => {
    const { book } = await world();
    await book();
    await expect(book({ in: D(12), out: D(15) })).rejects.toMatchObject({ code: "nights_unavailable" });
    expect(await StayNight.countDocuments()).toBe(3);
    await expectConsistent();
  });

  test("price changed: 409, nothing saved", async () => {
    const { book } = await world();
    await expect(book({ expectedTotalMinor: 1 })).rejects.toMatchObject({ code: "price_changed" });
    expect(await Reservation.countDocuments()).toBe(0);
    expect(await StayNight.countDocuments()).toBe(0);
  });

  test("a stored reservation is never invalid: check-out before check-in is refused by the model", async () => {
    const { host, guest, listing } = await world();
    const bad = new Reservation({
      listing: listing._id, guest: guest._id, host: host._id,
      checkIn: addDays(TODAY, 5), checkOut: addDays(TODAY, 4), nights: 1, guests: 1,
      status: "pending", idempotencyKey: "abcdefgh1234",
      pricingSnapshot: { totalMinor: 1, currency: "INR" },
    });
    await expect(bad.validate()).rejects.toThrow(/Check-out must be after check-in/);
  });

  describe("transitions", () => {
    test("accept, then host cancels: nights follow the status", async () => {
      const { book } = await world();
      const { reservation } = await book();
      await reservations.transition(reservation._id, "confirmed", { actor: "host" });
      expect(await StayNight.countDocuments({ holdExpiresAt: { $exists: true } })).toBe(0);
      await expectConsistent();
      await reservations.transition(reservation._id, "cancelled_by_host", { actor: "host", reason: "pipe burst" });
      expect(await StayNight.countDocuments()).toBe(0);
      const saved = await Reservation.findById(reservation._id);
      expect(saved.status).toBe("cancelled_by_host");
      expect(saved.statusHistory.map((h) => h.to)).toEqual(["pending", "confirmed", "cancelled_by_host"]);
      await expectConsistent();
    });

    test("host accepts while the guest cancels: one winner, 20 rounds", async () => {
      for (let round = 0; round < 20; round += 1) {
        const { book } = await world();
        const { reservation } = await book();
        const results = await Promise.allSettled([
          reservations.transition(reservation._id, "confirmed", { actor: "host" }),
          reservations.transition(reservation._id, "cancelled_by_guest", { actor: "guest" }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.find((r) => r.status === "rejected").reason.statusCode).toBe(409);
        await expectConsistent();
        await StayNight.deleteMany({});
        await Reservation.deleteMany({});
      }
    });

    test("an expired request frees its nights for the next guest", async () => {
      const { book, listing } = await world();
      const { reservation } = await book();
      const later = new Date(Date.now() + 25 * 3600 * 1000);
      await reservations.transition(reservation._id, "expired", { actor: "system", now: later });
      const { user: other } = await createUser();
      const { reservation: next } = await reservations.create({
        guest: other, listing: listing._id, in: D(10), out: D(13), guests: 1, idempotencyKey: key(),
      });
      expect(next.status).toBe("pending");
      await expectConsistent();
    });
  });

  test("a hold that ran out is taken over by the next request", async () => {
    const { book, listing } = await world();
    const { reservation } = await book();
    // age the hold on both the reservation and its nights
    const past = new Date(Date.now() - 60 * 1000);
    await Reservation.updateOne({ _id: reservation._id }, { holdExpiresAt: past });
    await StayNight.updateMany({ "source.id": reservation._id }, { holdExpiresAt: past });
    const { user: other } = await createUser();
    const { reservation: next } = await reservations.create({
      guest: other, listing: listing._id, in: D(10), out: D(13), guests: 1, idempotencyKey: key(),
    });
    expect(String(next._id)).not.toBe(String(reservation._id));
    // The old pending request is now an orphan the sweeper (P07-T07) will expire:
    // its nights belong to the new reservation.
    expect(await StayNight.countDocuments({ "source.id": next._id })).toBe(3);
    expect(mongoose.isValidObjectId(next._id)).toBe(true);
  });
});
