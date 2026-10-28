// P09-T04 against a real MongoDB: the unique night index while dates change,
// the compare-and-set on the reservation, real parallel requests, and the
// ledger/reservation invariants. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/modifications.db.test.js
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const { checkDatabase } = require("../helpers/invariants");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const reservations = require("../../src/services/reservations");
const modifications = require("../../src/services/modifications");
const ledger = require("../../src/services/ledger");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const TODAY = todayIn();
const D = (n) => formatDateOnly(addDays(TODAY, n));
let keyN = 0;
const key = () => `mod-key-${(keyN += 1)}-abcdefgh`;

describeDb("changing dates (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Promise.all([Reservation.init(), StayNight.init()]);
  });

  async function world({ instantBook = true } = {}) {
    const { user: host } = await createUser();
    const { user: guest } = await createUser();
    const { user: rival } = await createUser();
    const listing = await createListing({ owner: host, instantBook, capacity: { guests: 4 } });
    const book = async (who = guest, over = {}) =>
      (
        await reservations.create({
          guest: who,
          listing: listing._id,
          in: D(10),
          out: D(13),
          guests: 2,
          idempotencyKey: key(),
          ...over,
        })
      ).reservation;
    const change = (reservation, over = {}) =>
      modifications.changeDates({ id: String(reservation._id), user: guest, in: D(12), out: D(15), ...over });
    const nights = async (reservation) =>
      (await StayNight.find({ "source.id": reservation._id }).sort({ date: 1 }).lean()).map((r) => formatDateOnly(r.date));
    return { host, guest, rival, listing, book, change, nights };
  }

  const expectConsistent = async () => expect(await checkDatabase()).toEqual([]);

  test("a confirmed stay moves: the new nights are held, the old ones released, the record updated", async () => {
    const { book, change, nights } = await world();
    const booking = await book();
    const result = await change(booking);
    expect(result.reapproval).toBe(false);
    expect(await nights(booking)).toEqual([D(12), D(13), D(14)]);
    const stored = await Reservation.findById(booking._id).lean();
    expect(formatDateOnly(stored.checkIn)).toBe(D(12));
    expect(stored.modifications).toHaveLength(1);
    expect(stored.modifications[0].differenceMinor).toBe(stored.pricingSnapshot.totalMinor - booking.pricingSnapshot.totalMinor);
    expect(stored.statusHistory[stored.statusHistory.length - 1].note).toContain(D(12));
    await expectConsistent();
  });

  test("a pending request: the hold restarts on the reservation and on every night", async () => {
    const { book, change } = await world({ instantBook: false });
    const booking = await book();
    const later = new Date(Date.now() + 2 * 3600000);
    await change(booking, { now: later });
    const stored = await Reservation.findById(booking._id).lean();
    expect(stored.status).toBe("pending");
    expect(stored.holdExpiresAt.getTime()).toBe(later.getTime() + reservations.PENDING_HOLD_MS);
    const rows = await StayNight.find({ "source.id": booking._id }).lean();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.holdExpiresAt.getTime() === stored.holdExpiresAt.getTime())).toBe(true);
    await expectConsistent();
  });

  test("nights held by another booking: refused, the booking and the ledger are exactly as before", async () => {
    const { rival, book, change, nights } = await world();
    const booking = await book();
    await book(rival, { in: D(14), out: D(16) });
    const before = await StayNight.find({}).sort({ date: 1 }).lean();
    const error = await change(booking).catch((e) => e);
    expect(error.code).toBe("nights_unavailable");
    expect(await StayNight.find({}).sort({ date: 1 }).lean()).toEqual(before);
    expect(await nights(booking)).toEqual([D(10), D(11), D(12)]);
    expect((await Reservation.findById(booking._id).lean()).modifications).toHaveLength(0);
    await expectConsistent();
  });

  test("a host block in the way is a conflict too", async () => {
    const { listing, book, change, nights } = await world();
    const booking = await book();
    const blockId = new (require("mongoose").Types.ObjectId)();
    await ledger.reserveNights(listing._id, [new Date(`${D(14)}T00:00:00Z`)], { kind: "block", id: blockId });
    const error = await change(booking).catch((e) => e);
    expect(error.code).toBe("nights_unavailable");
    expect(await nights(booking)).toEqual([D(10), D(11), D(12)]);
    await expectConsistent();
  });

  test("ten parallel changes of one booking to different dates: exactly one wins and the ledger follows it", async () => {
    const { book, change, nights } = await world();
    const booking = await book();
    const attempts = Array.from({ length: 10 }, (_, i) =>
      change(booking, { in: D(20 + i * 4), out: D(23 + i * 4) }).then(() => "won", (e) => e),
    );
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
    outcomes.filter((o) => o !== "won").forEach((e) => expect(e.statusCode).toBe(409));
    const stored = await Reservation.findById(booking._id).lean();
    expect(stored.modifications).toHaveLength(1);
    const rows = await nights(booking);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(formatDateOnly(stored.checkIn));
    expect(await StayNight.countDocuments()).toBe(3); // no night of a lost attempt is left behind
    await expectConsistent();
  });

  test("two guests move onto the same free nights at once: one wins, nobody holds a night twice", async () => {
    const { listing, host, guest, rival, change } = await world();
    const a = (await reservations.create({ guest, listing: listing._id, in: D(10), out: D(12), guests: 2, idempotencyKey: key() })).reservation;
    const b = (await reservations.create({ guest: rival, listing: listing._id, in: D(30), out: D(32), guests: 2, idempotencyKey: key() })).reservation;
    const results = await Promise.all([
      change(a, { in: D(20), out: D(23) }).then(() => "won", (e) => e),
      modifications.changeDates({ id: String(b._id), user: rival, in: D(21), out: D(24) }).then(() => "won", (e) => e),
    ]);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(host).toBeDefined();
    await expectConsistent();
  });

  test("changing while the host cancels: one wins, and a cancelled booking leaves no night behind", async () => {
    const { book, change } = await world();
    for (let i = 0; i < 5; i += 1) {
      const booking = await book(undefined, { in: D(40 + i * 10), out: D(43 + i * 10) });
      const [, cancel] = await Promise.all([
        change(booking, { in: D(44 + i * 10), out: D(47 + i * 10) }).catch((e) => e),
        reservations.transition(booking._id, "cancelled_by_guest", { actor: "guest" }).catch((e) => e),
      ]);
      expect(cancel).toBeDefined();
    }
    await expectConsistent();
  });

  test("the same dates, a declined booking and someone else's booking change nothing", async () => {
    const { rival, book, change } = await world({ instantBook: false });
    const booking = await book();
    await expect(change(booking, { in: D(10), out: D(13) })).rejects.toMatchObject({ code: "no_change" });
    await expect(modifications.changeDates({ id: String(booking._id), user: rival, in: D(12), out: D(15) })).rejects.toMatchObject({ statusCode: 404 });
    await reservations.transition(booking._id, "declined", { actor: "host" });
    await expect(change(booking)).rejects.toMatchObject({ code: "not_modifiable" });
    await expectConsistent();
  });

  test("giving the old nights up can be repeated: trimNights is idempotent on the real index", async () => {
    const { book, change } = await world();
    const booking = await book();
    await change(booking);
    const keep = [12, 13, 14].map((n) => new Date(`${D(n)}T00:00:00Z`));
    await expect(ledger.trimNights(booking._id, keep)).resolves.toEqual({ released: 0 });
    await expectConsistent();
  });
});
