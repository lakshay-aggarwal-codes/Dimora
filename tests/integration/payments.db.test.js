// P16-T01 against a real MongoDB: the three unique rules of PaymentAttempt, a
// payment racing the sweeper, and the refund record. Skipped with SKIP_DB_TESTS=1.
//
//   npx jest payments.db
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const { checkDatabase } = require("../helpers/invariants");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const PaymentAttempt = require("../../src/models/paymentAttempt");
const reservations = require("../../src/services/reservations");
const payments = require("../../src/services/payments");
const { createSweeper } = require("../../src/services/sweeper");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const TODAY = todayIn();
const D = (n) => formatDateOnly(addDays(TODAY, n));
let keyN = 0;
const key = () => `pay-db-${(keyN += 1)}-abcdefgh`;
const MIN = 60 * 1000;

describeDb("simulated payments (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Promise.all([Reservation.init(), StayNight.init(), PaymentAttempt.init()]);
  });

  async function world({ instantBook = false } = {}) {
    const { user: host } = await createUser();
    const { user: guest } = await createUser();
    const listing = await createListing({ owner: host, instantBook, capacity: { guests: 4 } });
    const book = async (over = {}) =>
      (
        await reservations.create({
          guest,
          listing: listing._id,
          in: D(10),
          out: D(13),
          guests: 2,
          idempotencyKey: key(),
          awaitPayment: true,
          ...over,
        })
      ).reservation;
    const pay = (reservation, over = {}) =>
      payments.pay({ reservationId: reservation._id, guest, idempotencyKey: key(), ...over });
    return { host, guest, listing, book, pay };
  }

  const expectConsistent = async () => expect(await checkDatabase()).toEqual([]);

  test("the indexes exist: one attempt per key, one live charge, one refund", async () => {
    const indexes = await PaymentAttempt.collection.indexes();
    const named = (name) => indexes.find((i) => i.name === name);
    expect(named("one_live_charge_per_reservation")).toMatchObject({ unique: true, partialFilterExpression: { live: true } });
    expect(named("one_refund_per_reservation")).toMatchObject({ unique: true, partialFilterExpression: { kind: "refund" } });
    expect(indexes.some((i) => i.key.reservation === 1 && i.key.idempotencyKey === 1 && i.unique)).toBe(true);
  });

  test("a booking that waits for payment holds its nights for 15 minutes; paying confirms an instant-book stay", async () => {
    const { book, pay } = await world({ instantBook: true });
    const waiting = await book();
    expect(waiting.status).toBe("awaiting_payment");
    expect(waiting.holdExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * MIN);
    expect(await StayNight.countDocuments({ "source.id": waiting._id, holdExpiresAt: { $exists: true } })).toBe(3);
    await expectConsistent();

    const result = await pay(waiting);
    expect(result).toMatchObject({ ok: true, status: "paid" });
    const stored = await Reservation.findById(waiting._id).lean();
    expect(stored.status).toBe("confirmed");
    expect(stored.paymentStatus).toBe("simulated_paid");
    expect(stored.holdExpiresAt).toBeUndefined();
    expect(await StayNight.countDocuments({ "source.id": waiting._id, holdExpiresAt: { $exists: true } })).toBe(0);
    await expectConsistent();
  });

  test("a request-to-book stay becomes pending with a fresh 24-hour hold on the booking and its nights", async () => {
    const { book, pay } = await world();
    const waiting = await book();
    await pay(waiting);
    const stored = await Reservation.findById(waiting._id).lean();
    expect(stored.status).toBe("pending");
    expect(stored.holdExpiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 60 * MIN);
    await expectConsistent();
  });

  test("two clicks with the same key at once: one attempt; two keys at once: one charge", async () => {
    const { book, pay } = await world();
    const waiting = await book();
    const k = key();
    await Promise.all([pay(waiting, { idempotencyKey: k }), pay(waiting, { idempotencyKey: k })]);
    expect(await PaymentAttempt.countDocuments({ reservation: waiting._id, kind: "charge" })).toBe(1);

    const other = await world();
    const second = await other.book();
    const results = await Promise.all([
      payments.pay({ reservationId: second._id, guest: other.guest, idempotencyKey: key() }),
      payments.pay({ reservationId: second._id, guest: other.guest, idempotencyKey: key() }),
    ]);
    expect(await PaymentAttempt.countDocuments({ reservation: second._id, kind: "charge" })).toBe(1);
    expect(results.filter((r) => r.status === "paid")).toHaveLength(1);
    await expectConsistent();
  });

  test("a declined payment keeps the nights held and lets the guest try again", async () => {
    const { book, pay } = await world();
    const waiting = await book();
    const first = await pay(waiting, { outcome: "declined" });
    expect(first).toMatchObject({ ok: false, failureCode: "declined" });
    expect((await Reservation.findById(waiting._id).lean()).status).toBe("awaiting_payment");
    expect(await StayNight.countDocuments({ "source.id": waiting._id })).toBe(3);
    const failed = await PaymentAttempt.findOne({ reservation: waiting._id }).lean();
    expect(failed).toMatchObject({ status: "failed", live: false, failureCode: "declined" });
    expect(await pay(waiting)).toMatchObject({ ok: true, status: "paid" });
    expect(await PaymentAttempt.countDocuments({ reservation: waiting._id })).toBe(2);
    await expectConsistent();
  });

  test("an unpaid booking expires with its own reason after its hold, and the nights are free again", async () => {
    const { book } = await world();
    const waiting = await book();
    // the driver, not Mongoose: the hold is moved into the past on the booking and its nights
    const past = new Date(Date.now() - MIN);
    await Reservation.collection.updateOne({ _id: waiting._id }, { $set: { holdExpiresAt: past } });
    await StayNight.collection.updateMany({ "source.id": waiting._id }, { $set: { holdExpiresAt: past } });
    const summary = await createSweeper().runOnce();
    expect(summary.expired).toBe(1);
    const stored = await Reservation.findById(waiting._id).lean();
    expect(stored.status).toBe("expired");
    expect(stored.statusHistory.at(-1).note).toBe("The payment was not completed in time.");
    expect(await StayNight.countDocuments({ "source.id": waiting._id })).toBe(0);
    expect(await PaymentAttempt.countDocuments({})).toBe(0);
    await expectConsistent();
  });

  test("after the hold nothing can be paid (409), and nothing is stored", async () => {
    const { book, pay } = await world();
    const waiting = await book();
    await Reservation.collection.updateOne({ _id: waiting._id }, { $set: { holdExpiresAt: new Date(Date.now() - MIN) } });
    await expect(pay(waiting)).rejects.toMatchObject({ statusCode: 409, code: "payment_hold_expired" });
    expect(await PaymentAttempt.countDocuments({})).toBe(0);
  });

  test("a paid booking that the host declines gets one refunded_simulated record and the booking says so", async () => {
    const { book, pay } = await world();
    const waiting = await book();
    await pay(waiting);
    await reservations.transition(waiting._id, "declined", { actor: "host", reason: "Sorry" });
    const refunds = await PaymentAttempt.find({ reservation: waiting._id, kind: "refund" }).lean();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: "refunded_simulated", live: false });
    const stored = await Reservation.findById(waiting._id).lean();
    expect(refunds[0].amountMinor).toBe(stored.pricingSnapshot.totalMinor);
    expect(stored.paymentStatus).toBe("refunded_simulated");
    // the unique rule: a second refund for the same booking cannot be written
    await expect(
      PaymentAttempt.create({
        reservation: waiting._id,
        guest: stored.guest,
        kind: "refund",
        status: "refunded_simulated",
        amountMinor: 1,
        currency: "INR",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 11000 });
    await expectConsistent();
  });

  test("the model has no place for card data: a stray field is dropped", async () => {
    const { book, guest } = await world();
    const waiting = await book();
    const attempt = await PaymentAttempt.create({
      reservation: waiting._id,
      guest: guest._id,
      kind: "charge",
      status: "pending",
      amountMinor: 100,
      currency: "INR",
      idempotencyKey: key(),
      cardNumber: "4111111111111111",
      cvv: "123",
    });
    const raw = await PaymentAttempt.collection.findOne({ _id: attempt._id });
    expect(Object.keys(raw).join(" ")).not.toMatch(/card|cvv|expiry/i);
  });
});
