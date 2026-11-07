// P16-T01: the simulated payment service over in-memory fakes (no mongod). The
// fake attempt model enforces the same three unique rules as the real indexes
// (tests/integration/payments.db.test.js checks them on a real MongoDB), and the
// reservation service is the REAL one over the shared reservation/ledger fakes,
// so "the booking moves only on success" is tested through the real transition.
const { createPaymentService } = require("../../src/services/payments");
const { createReservationService } = require("../../src/services/reservations");
const provider = require("../../src/services/paymentProviders/simulated");
const pricing = require("../../src/services/pricing");
const {
  FakeReservationModel,
  FakeLedger,
  fakeId,
} = require("../helpers/fakeReservationDeps");
const { findViolations } = require("../helpers/invariants");
const {
  NotFoundError,
  ValidationError,
  ForbiddenError,
} = require("../../src/utils/errors");

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = new Date("2026-11-10T06:00:00.000Z");
const at = (ms) => new Date(T0.getTime() + ms);
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const same = (a, b) => String(a) === String(b);

class ReservationsWithUpdate extends FakeReservationModel {
  async updateOne(filter, update) {
    const doc = this.docs.find((d) =>
      Object.entries(filter).every(([k, v]) => same(d[k], v)),
    );
    if (!doc) return { modifiedCount: 0 };
    Object.assign(doc, update.$set || {});
    return { modifiedCount: 1 };
  }
}

// The three unique indexes of models/paymentAttempt.js, as rules.
class FakeAttemptModel {
  constructor() {
    this.docs = [];
    this.createdAt = T0;
  }
  async create(doc) {
    await Promise.resolve();
    const clash = this.docs.some(
      (d) =>
        same(d.reservation, doc.reservation) &&
        (d.idempotencyKey === doc.idempotencyKey ||
          (doc.live === true && d.live === true) ||
          (doc.kind === "refund" && d.kind === "refund")),
    );
    if (clash) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const stored = { _id: fakeId(), createdAt: this.createdAt, live: false, ...doc };
    this.docs.push(stored);
    return stored;
  }
  async findOne(filter) {
    await Promise.resolve();
    return (
      this.docs.find((d) =>
        Object.entries(filter).every(([k, v]) => same(d[k], v)),
      ) || null
    );
  }
  async updateOne(filter, update) {
    await Promise.resolve();
    const doc = this.docs.find((d) =>
      Object.entries(filter).every(([k, v]) => same(d[k], v)),
    );
    if (!doc) return { modifiedCount: 0 };
    Object.assign(doc, update.$set || {});
    return { modifiedCount: 1 };
  }
}

function setup({ instant = false, hold = at(15 * MIN), totalMinor = 985600, providerOverride } = {}) {
  const Reservation = new ReservationsWithUpdate();
  const ledger = new FakeLedger();
  const Attempt = new FakeAttemptModel();
  const prov = providerOverride || provider;
  const events = [];
  let payments;
  const reservationService = createReservationService({
    ReservationModel: Reservation,
    ListingModel: { findById: async () => null },
    ledgerService: ledger,
    pricing,
    newId: fakeId,
    notifier: { dispatch: async (event) => events.push(event) },
    refunder: { refund: (...args) => payments.refundRelease(...args) },
  });
  payments = createPaymentService({
    AttemptModel: Attempt,
    ReservationModel: Reservation,
    reservationService,
    provider: prov,
  });

  const guest = { _id: fakeId() };
  const _id = fakeId();
  const listing = fakeId();
  const reservation = {
    _id,
    listing,
    guest: guest._id,
    host: fakeId(),
    checkIn: day("2026-12-01"),
    checkOut: day("2026-12-04"),
    nights: 3,
    guests: 2,
    status: "awaiting_payment",
    holdExpiresAt: hold,
    statusHistory: [{ from: null, to: "awaiting_payment", at: T0, actor: "guest" }],
    pricingSnapshot: { totalMinor, currency: "INR" },
    listingSnapshot: { instantBook: instant, timezone: "Asia/Kolkata" },
    paymentStatus: "none",
  };
  Reservation.docs.push(reservation);
  for (let t = reservation.checkIn.getTime(); t < reservation.checkOut.getTime(); t += DAY) {
    const date = new Date();
    date.setTime(t);
    ledger.rows.push({ listing, date, source: { kind: "reservation", id: _id }, holdExpiresAt: hold });
  }
  return {
    Reservation,
    ledger,
    Attempt,
    payments,
    reservationService,
    guest,
    reservation,
    events,
    pay: (over = {}, opts = { now: T0 }) =>
      payments.pay(
        { reservationId: _id, guest, idempotencyKey: "key-one-0001", ...over },
        opts,
      ),
    consistent: () =>
      expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]),
    statusOf: () => Reservation.docs.find((d) => d._id === _id).status,
  };
}

describe("pay: success moves the booking on", () => {
  test("a request-to-book listing: the booking becomes pending with a fresh 24-hour hold, the host is told now", async () => {
    const ctx = setup({ instant: false });
    const result = await ctx.pay();
    expect(result).toMatchObject({ ok: true, status: "paid" });
    const doc = ctx.Reservation.docs[0];
    expect(doc.status).toBe("pending");
    expect(doc.paymentStatus).toBe("simulated_paid");
    expect(doc.holdExpiresAt.getTime()).toBe(T0.getTime() + DAY);
    expect(ctx.ledger.rows.every((r) => r.holdExpiresAt.getTime() === T0.getTime() + DAY)).toBe(true);
    expect(doc.statusHistory.at(-1)).toMatchObject({
      from: "awaiting_payment",
      to: "pending",
      actor: "guest",
    });
    expect(ctx.events).toEqual(["reservation.requested"]);
    ctx.consistent();
  });

  test("an instant-book listing: confirmed, no hold left on the booking or its nights, the host is told 'booked'", async () => {
    const ctx = setup({ instant: true });
    await ctx.pay();
    const doc = ctx.Reservation.docs[0];
    expect(doc.status).toBe("confirmed");
    expect(doc.paymentStatus).toBe("simulated_paid");
    expect(doc).not.toHaveProperty("holdExpiresAt");
    expect(ctx.ledger.rows.some((r) => r.holdExpiresAt)).toBe(false);
    expect(ctx.events).toEqual(["reservation.booked"]);
    ctx.consistent();
  });

  test("the stored attempt is a succeeded simulated charge of exactly the booking's total", async () => {
    const ctx = setup({ totalMinor: 123400 });
    await ctx.pay();
    expect(ctx.Attempt.docs).toHaveLength(1);
    expect(ctx.Attempt.docs[0]).toMatchObject({
      provider: "simulated",
      kind: "charge",
      status: "succeeded",
      amountMinor: 123400,
      currency: "INR",
      live: true,
    });
  });

  test("an attempt keeps no card-shaped field, whatever the caller sends", async () => {
    const ctx = setup();
    await ctx.pay({ cardNumber: "4111111111111111", cvv: "123", expiry: "12/30" });
    const keys = Object.keys(ctx.Attempt.docs[0]).join(" ");
    expect(keys).not.toMatch(/card|cvv|cvc|expiry|pan|number/i);
    expect(JSON.stringify(ctx.Attempt.docs)).not.toContain("4111");
  });
});

describe("pay: a refusal leaves the nights held and the booking waiting", () => {
  test.each([
    ["declined", "declined"],
    ["error", "service_error"],
  ])("outcome %s", async (outcome, code) => {
    const ctx = setup();
    const result = await ctx.pay({ outcome });
    expect(result).toMatchObject({ ok: false, status: "failed", failureCode: code });
    expect(ctx.statusOf()).toBe("awaiting_payment");
    expect(ctx.Reservation.docs[0].paymentStatus).toBe("none");
    expect(ctx.ledger.rows).toHaveLength(3);
    expect(ctx.events).toEqual([]);
    expect(ctx.Attempt.docs[0]).toMatchObject({ status: "failed", failureCode: code, live: false });
    ctx.consistent();
  });

  test("the guest may try again with a new key after a refusal, and that one can succeed", async () => {
    const ctx = setup();
    await ctx.pay({ outcome: "declined", idempotencyKey: "key-one-0001" });
    const second = await ctx.pay({ outcome: "success", idempotencyKey: "key-two-0002" });
    expect(second).toMatchObject({ ok: true, status: "paid" });
    expect(ctx.Attempt.docs.map((a) => a.status)).toEqual(["failed", "succeeded"]);
    expect(ctx.statusOf()).toBe("pending");
  });

  test("a provider that blows up unexpectedly frees the live slot and the error is not hidden", async () => {
    const broken = { ...provider, charge: async () => { throw new Error("boom"); } };
    const ctx = setup({ providerOverride: broken });
    await expect(ctx.pay()).rejects.toThrow("boom");
    expect(ctx.Attempt.docs[0]).toMatchObject({ status: "failed", live: false, failureCode: "internal_error" });
    expect(ctx.statusOf()).toBe("awaiting_payment");
  });
});

describe("pay: a double click cannot create two attempts", () => {
  test("the same key twice in a row: one attempt, the second answers what the first did", async () => {
    const ctx = setup();
    const first = await ctx.pay();
    const second = await ctx.pay();
    expect(ctx.Attempt.docs).toHaveLength(1);
    expect(first.status).toBe("paid");
    expect(second).toMatchObject({ ok: true, status: "paid", replay: true });
    expect(ctx.events).toEqual(["reservation.requested"]); // the host is told once
  });

  test("the same key at the same time: one attempt, one payment", async () => {
    const ctx = setup();
    const results = await Promise.all([ctx.pay(), ctx.pay()]);
    expect(ctx.Attempt.docs).toHaveLength(1);
    expect(results.filter((r) => r.status === "paid" && !r.replay)).toHaveLength(1);
    expect(ctx.events).toEqual(["reservation.requested"]);
    ctx.consistent();
  });

  test("two different keys at the same time (two tabs): one charge only", async () => {
    const ctx = setup();
    const results = await Promise.all([
      ctx.pay({ idempotencyKey: "tab-one-0001" }),
      ctx.pay({ idempotencyKey: "tab-two-0002" }),
    ]);
    expect(ctx.Attempt.docs.filter((a) => a.kind === "charge")).toHaveLength(1);
    // the second tab meets either the charge still running or the finished one
    expect(results.filter((r) => r.status === "paid")).toHaveLength(1);
    expect(results.every((r) => ["paid", "in_progress", "already_paid"].includes(r.status))).toBe(true);
    expect(ctx.events).toEqual(["reservation.requested"]);
    ctx.consistent();
  });

  test("a second key after the booking is already paid answers 'already paid' and charges nothing", async () => {
    const ctx = setup();
    await ctx.pay({ idempotencyKey: "key-one-0001" });
    const again = await ctx.pay({ idempotencyKey: "key-two-0002" });
    expect(again).toMatchObject({ ok: true, status: "already_paid" });
    expect(ctx.Attempt.docs).toHaveLength(1);
  });

  test("an abandoned pending attempt (the process died) does not block a new try forever", async () => {
    const ctx = setup();
    await ctx.Attempt.create({
      reservation: ctx.reservation._id,
      guest: ctx.guest._id,
      kind: "charge",
      status: "pending",
      amountMinor: 985600,
      currency: "INR",
      idempotencyKey: "ghost-key-001",
      live: true,
    });
    // a fresh pending attempt is respected...
    const busy = await ctx.pay({ idempotencyKey: "key-one-0001" }, { now: at(5 * 1000) });
    expect(busy.status).toBe("in_progress");
    // ...an old one is not
    const later = await ctx.pay({ idempotencyKey: "key-two-0002" }, { now: at(2 * MIN) });
    expect(later).toMatchObject({ ok: true, status: "paid" });
    expect(ctx.Attempt.docs.find((a) => a.idempotencyKey === "ghost-key-001")).toMatchObject({
      status: "failed",
      failureCode: "abandoned",
      live: false,
    });
  });
});

describe("pay: who and when", () => {
  test("someone else's booking is a 404, exactly like a booking that does not exist", async () => {
    const ctx = setup();
    await expect(ctx.pay({ guest: { _id: fakeId() } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(ctx.pay({ reservationId: fakeId() })).rejects.toBeInstanceOf(NotFoundError);
    expect(ctx.Attempt.docs).toHaveLength(0);
  });

  test("a suspended account cannot pay", async () => {
    const ctx = setup();
    await expect(
      ctx.pay({ guest: { _id: ctx.guest._id, status: "suspended" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a bad key or an unknown outcome is a 400 and nothing is stored", async () => {
    const ctx = setup();
    for (const bad of [undefined, "", "short", "has space here!", "x".repeat(65), ["array-key-001"]]) {
      await expect(ctx.pay({ idempotencyKey: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(ctx.pay({ outcome: "free-money" })).rejects.toBeInstanceOf(ValidationError);
    expect(ctx.Attempt.docs).toHaveLength(0);
  });

  test("after the payment hold has run out nothing is charged (409 payment_hold_expired)", async () => {
    const ctx = setup({ hold: at(15 * MIN) });
    await expect(ctx.pay({}, { now: at(16 * MIN) })).rejects.toMatchObject({
      statusCode: 409,
      code: "payment_hold_expired",
    });
    expect(ctx.Attempt.docs).toHaveLength(0);
  });

  test("a booking that is not waiting for payment (expired, say) is refused with 409", async () => {
    const ctx = setup();
    ctx.Reservation.docs[0].status = "expired";
    await expect(ctx.pay()).rejects.toMatchObject({ statusCode: 409, code: "not_awaiting_payment" });
  });

  test("the sweeper winning while the provider answers: the attempt is voided, the booking stays expired, nothing is 'paid'", async () => {
    const ctx = setup();
    // the provider "takes a while"; meanwhile the sweeper expires the booking
    const slow = {
      ...provider,
      charge: async (args) => {
        await ctx.reservationService.transition(ctx.reservation._id, "expired", {
          actor: "system",
          now: at(16 * MIN),
        });
        return provider.charge(args);
      },
    };
    const racing = createPaymentService({
      AttemptModel: ctx.Attempt,
      ReservationModel: ctx.Reservation,
      reservationService: ctx.reservationService,
      provider: slow,
    });
    const result = await racing.pay(
      { reservationId: ctx.reservation._id, guest: ctx.guest, idempotencyKey: "key-one-0001" },
      { now: at(14 * MIN) },
    );
    expect(result).toMatchObject({ ok: false, status: "failed", failureCode: "hold_expired" });
    expect(ctx.statusOf()).toBe("expired");
    expect(ctx.Reservation.docs[0].paymentStatus).toBe("none");
    expect(ctx.Attempt.docs[0]).toMatchObject({ status: "failed", live: false });
    expect(ctx.ledger.rows).toHaveLength(0);
    ctx.consistent();
  });
});

describe("refundRelease: a paid booking that ends without a stay", () => {
  test("is recorded once, as refunded_simulated, and the booking says so", async () => {
    const ctx = setup({ instant: true, totalMinor: 500000 });
    await ctx.pay();
    const paid = ctx.Reservation.docs[0];
    const first = await ctx.payments.refundRelease(paid, { now: at(MIN) });
    expect(first.created).toBe(true);
    expect(paid.paymentStatus).toBe("refunded_simulated");
    // the booking already says refunded: a second call has nothing to do
    expect(await ctx.payments.refundRelease(paid, { now: at(2 * MIN) })).toBeNull();
    // and even if the booking's flag were stale (a crash between the two writes),
    // the unique rule keeps it at one refund record
    paid.paymentStatus = "simulated_paid";
    const again = await ctx.payments.refundRelease(paid, { now: at(3 * MIN) });
    expect(again.created).toBe(false);
    const refunds = ctx.Attempt.docs.filter((a) => a.kind === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: "refunded_simulated", amountMinor: 500000, currency: "INR" });
    expect(paid.paymentStatus).toBe("refunded_simulated");
  });

  test("never more than was charged, and nothing for 0 or for a booking that was never paid", async () => {
    const ctx = setup({ instant: true, totalMinor: 500000 });
    expect(await ctx.payments.refundRelease(ctx.Reservation.docs[0])).toBeNull(); // not paid yet
    await ctx.pay();
    const paid = ctx.Reservation.docs[0];
    expect(await ctx.payments.refundRelease(paid, { amountMinor: 0 })).toBeNull();
    const result = await ctx.payments.refundRelease(paid, { amountMinor: 9999999 });
    expect(result.attempt.amountMinor).toBe(500000);
  });

  test("the guest cancelling gets the amount the policy worked out (through the real transition)", async () => {
    const ctx = setup({ instant: true, totalMinor: 500000 });
    await ctx.pay();
    await ctx.reservationService.transition(ctx.reservation._id, "cancelled_by_guest", {
      actor: "guest",
      now: at(MIN),
      refund: { refundMinor: 250000, retainedMinor: 250000, totalMinor: 500000, rule: "half" },
    });
    const refunds = ctx.Attempt.docs.filter((a) => a.kind === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amountMinor).toBe(250000);
    expect(ctx.Reservation.docs[0].paymentStatus).toBe("refunded_simulated");
    expect(ctx.ledger.rows).toHaveLength(0);
    ctx.consistent();
  });

  test("a host declining a paid request gets the whole amount back on paper", async () => {
    const ctx = setup({ instant: false, totalMinor: 500000 });
    await ctx.pay();
    await ctx.reservationService.transition(ctx.reservation._id, "declined", {
      actor: "host",
      now: at(MIN),
    });
    const refunds = ctx.Attempt.docs.filter((a) => a.kind === "refund");
    expect(refunds.map((r) => r.amountMinor)).toEqual([500000]);
    ctx.consistent();
  });

  test("a failing refund record never changes the cancellation", async () => {
    const ctx = setup({ instant: true });
    await ctx.pay();
    ctx.Attempt.create = async () => {
      throw new Error("db down");
    };
    const done = await ctx.reservationService.transition(ctx.reservation._id, "cancelled_by_host", {
      actor: "host",
      now: at(MIN),
    });
    expect(done.status).toBe("cancelled_by_host");
    ctx.consistent();
  });

  test("an unpaid booking that expires asks for no refund and tells nobody", async () => {
    const ctx = setup();
    await ctx.reservationService.transition(ctx.reservation._id, "expired", {
      actor: "system",
      now: at(16 * MIN),
    });
    expect(ctx.Attempt.docs).toHaveLength(0);
    expect(ctx.events).toEqual([]);
    ctx.consistent();
  });
});
