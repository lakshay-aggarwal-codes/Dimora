// P16-T01: creating a booking that waits for its simulated payment, over the
// shared in-memory fakes. Paying it is tests/unit/payments.service.test.js.
const {
  createReservationService,
  PENDING_HOLD_MS,
  PAYMENT_HOLD_MS,
} = require("../../src/services/reservations");
const pricing = require("../../src/services/pricing");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");
const {
  FakeReservationModel,
  FakeListingModel,
  FakeLedger,
  fakeId,
} = require("../helpers/fakeReservationDeps");
const { findViolations } = require("../helpers/invariants");

const NOW = new Date();
const TODAY = todayIn("Asia/Kolkata", NOW);
const D = (n) => formatDateOnly(addDays(TODAY, n));
const HOST = { _id: fakeId() };
const GUEST = { _id: fakeId(), status: "active" };
let keyN = 0;
const key = () => `pay-key-${(keyN += 1)}-abcdefgh`;

function listingDoc(extra = {}) {
  return {
    _id: fakeId(), owner: HOST._id, status: "published", deletedAt: null, title: "Sea house",
    address: { city: "Goa" }, pricing: { nightlyMinor: 250000, cleaningFeeMinor: 50000, currency: "INR" },
    capacity: { guests: 4 }, minNights: 1, maxNights: 14, instantBook: false, cancellationPolicy: "moderate",
    checkInTime: "14:00", checkOutTime: "11:00", timezone: "Asia/Kolkata", houseRules: "No parties",
    images: [{ url: "https://img/x.jpg" }], ...extra,
  };
}

function setup(listingExtra) {
  const Reservation = new FakeReservationModel();
  const listing = listingDoc(listingExtra);
  const ledger = new FakeLedger();
  const sent = [];
  const service = createReservationService({
    ReservationModel: Reservation,
    ListingModel: new FakeListingModel([listing]),
    ledgerService: ledger,
    pricing,
    newId: fakeId,
    notifier: { dispatch: async (event) => sent.push(event) },
    replayRetries: 20,
    replayDelayMs: 0,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const book = (over = {}) =>
    service.create(
      { guest: GUEST, listing: listing._id, in: D(10), out: D(13), guests: 2, idempotencyKey: key(), ...over },
      { now: NOW },
    );
  return { Reservation, ledger, service, book, sent, consistent: () => expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]) };
}

describe("create with awaitPayment", () => {
  test("is awaiting_payment with its own 15-minute hold on the booking and on every night, not the host's 24 hours", async () => {
    const { ledger, book, consistent } = setup();
    const { reservation, created } = await book({ awaitPayment: true });
    expect(created).toBe(true);
    expect(reservation.status).toBe("awaiting_payment");
    expect(PAYMENT_HOLD_MS).toBe(15 * 60 * 1000);
    expect(reservation.holdExpiresAt.getTime()).toBe(NOW.getTime() + PAYMENT_HOLD_MS);
    expect(reservation.holdExpiresAt.getTime()).toBeLessThan(NOW.getTime() + PENDING_HOLD_MS);
    expect(ledger.rows).toHaveLength(3);
    expect(ledger.rows.every((r) => r.holdExpiresAt.getTime() === reservation.holdExpiresAt.getTime())).toBe(true);
    expect(reservation.statusHistory[0]).toMatchObject({ from: null, to: "awaiting_payment", actor: "guest" });
    consistent();
  });

  test("the same holds for an instant-book listing (nothing is confirmed before it is paid) and keeps the listing's mode for later", async () => {
    const { ledger, book } = setup({ instantBook: true });
    const { reservation } = await book({ awaitPayment: true });
    expect(reservation.status).toBe("awaiting_payment");
    expect(reservation.listingSnapshot.instantBook).toBe(true);
    expect(ledger.rows.every((r) => r.holdExpiresAt)).toBe(true);
  });

  test("the host is told nothing until it is paid", async () => {
    const { book, sent } = setup();
    await book({ awaitPayment: true });
    expect(sent).toEqual([]);
  });

  test("without the flag nothing changes: pending for a request, confirmed for instant book, the host is told", async () => {
    const a = setup();
    expect((await a.book()).reservation.status).toBe("pending");
    expect(a.sent).toEqual(["reservation.requested"]);
    const b = setup({ instantBook: true });
    expect((await b.book()).reservation.status).toBe("confirmed");
    expect(b.sent).toEqual(["reservation.booked"]);
    // only the exact value true switches the step on
    const c = setup();
    expect((await c.book({ awaitPayment: "true" })).reservation.status).toBe("pending");
  });

  test("a caller's own hold length is used between a minute and an hour, and ignored outside that", async () => {
    for (const [ms, expected] of [
      [5 * 60 * 1000, 5 * 60 * 1000],
      [60 * 60 * 1000, 60 * 60 * 1000],
      [1000, PAYMENT_HOLD_MS],
      [2 * 60 * 60 * 1000, PAYMENT_HOLD_MS],
      ["900000", PAYMENT_HOLD_MS],
      [undefined, PAYMENT_HOLD_MS],
    ]) {
      const { book } = setup();
      const { reservation } = await book({ awaitPayment: true, paymentHoldMs: ms });
      expect(reservation.holdExpiresAt.getTime() - NOW.getTime()).toBe(expected);
    }
  });

  test("the nights are really held: a second guest cannot book the same nights while the payment is pending", async () => {
    const { book } = setup();
    await book({ awaitPayment: true });
    await expect(book({ awaitPayment: true, guest: { _id: fakeId(), status: "active" } })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test("a repeated key returns the same booking and holds nothing twice", async () => {
    const { ledger, book } = setup();
    const k = key();
    const first = await book({ awaitPayment: true, idempotencyKey: k });
    const again = await book({ awaitPayment: true, idempotencyKey: k });
    expect(again.created).toBe(false);
    expect(again.reservation._id).toBe(first.reservation._id);
    expect(ledger.rows).toHaveLength(3);
  });
});
