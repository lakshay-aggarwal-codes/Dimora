// P07-T05: reservations.create and reservations.transition against in-memory
// fakes (no database). Every test ends by checking the ledger/reservation
// invariants.
const { createReservationService, PENDING_HOLD_MS } = require("../../src/services/reservations");
const pricing = require("../../src/services/pricing");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");
const {
  ValidationError, ForbiddenError, NotFoundError, ConflictError, PriceChangedError, InvalidTransitionError,
} = require("../../src/utils/errors");
const { FakeReservationModel, FakeListingModel, FakeLedger, fakeId } = require("../helpers/fakeReservationDeps");
const { findViolations } = require("../helpers/invariants");

const NOW = new Date();
const TODAY = todayIn("Asia/Kolkata", NOW);
const D = (n) => formatDateOnly(addDays(TODAY, n));
const HOST = { _id: fakeId() };
const GUEST = { _id: fakeId(), status: "active" };
const GUEST2 = { _id: fakeId() };
let keyN = 0;
const key = () => `key-${(keyN += 1)}-abcdefgh`;

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
  const Listing = new FakeListingModel([listing]);
  const ledger = new FakeLedger();
  const service = createReservationService({
    ReservationModel: Reservation, ListingModel: Listing, ledgerService: ledger, pricing,
    newId: fakeId, replayRetries: 20, replayDelayMs: 0, sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const book = (over = {}) =>
    service.create({ guest: GUEST, listing: listing._id, in: D(10), out: D(13), guests: 2, idempotencyKey: key(), ...over }, { now: NOW });
  const consistent = () => expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]);
  return { Reservation, Listing, ledger, listing, service, book, consistent };
}

describe("create: success paths", () => {
  test("host-approval listing: pending, 24 h hold, nights held with the same hold", async () => {
    const { Reservation, ledger, book, consistent } = setup();
    const { reservation, created } = await book();
    expect(created).toBe(true);
    expect(reservation.status).toBe("pending");
    expect(reservation.holdExpiresAt.getTime()).toBe(NOW.getTime() + PENDING_HOLD_MS);
    expect(ledger.rows).toHaveLength(3);
    expect(ledger.rows.every((r) => r.holdExpiresAt.getTime() === reservation.holdExpiresAt.getTime())).toBe(true);
    expect(reservation.statusHistory).toHaveLength(1);
    expect(reservation.statusHistory[0]).toEqual(expect.objectContaining({ from: null, to: "pending", actor: "guest" }));
    expect(Reservation.docs).toHaveLength(1);
    consistent();
  });

  test("instant-book listing: confirmed at once, no hold anywhere", async () => {
    const { ledger, book, consistent } = setup({ instantBook: true });
    const { reservation } = await book();
    expect(reservation.status).toBe("confirmed");
    expect(reservation.holdExpiresAt).toBeUndefined();
    expect(ledger.rows.some((r) => r.holdExpiresAt)).toBe(false);
    consistent();
  });

  test("the stored snapshot is the quote: same total, same lines", async () => {
    const { listing, book } = setup();
    const { reservation } = await book({ expectedTotalMinor: undefined });
    const quote = pricing.quote({ listing, checkIn: D(10), checkOut: D(13), guests: 2 });
    expect(reservation.pricingSnapshot).toEqual(quote);
    expect(reservation.nights).toBe(3);
    expect(reservation.host).toBe(HOST._id);
    expect(reservation.listingSnapshot).toEqual(expect.objectContaining({
      title: "Sea house", city: "Goa", coverUrl: "https://img/x.jpg", cancellationPolicy: "moderate", houseRules: "No parties",
    }));
  });

  test("a matching expectedTotalMinor (number or digit string) is accepted", async () => {
    const { listing, book } = setup();
    const total = pricing.quote({ listing, checkIn: D(10), checkOut: D(13), guests: 2 }).totalMinor;
    await expect(book({ expectedTotalMinor: total })).resolves.toBeDefined();
    await expect(book({ in: D(20), out: D(22), expectedTotalMinor: String(pricing.quote({ listing, checkIn: D(20), checkOut: D(22), guests: 2 }).totalMinor) })).resolves.toBeDefined();
  });
});

describe("create: idempotency", () => {
  test("the same key and stay returns the original and holds nothing twice", async () => {
    const { Reservation, ledger, book, consistent } = setup();
    const k = key();
    const first = await book({ idempotencyKey: k });
    const second = await book({ idempotencyKey: k });
    expect(second.created).toBe(false);
    expect(second.reservation._id).toBe(first.reservation._id);
    expect(Reservation.docs).toHaveLength(1);
    expect(ledger.rows).toHaveLength(3);
    consistent();
  });

  test("a double click (two requests at once) makes one reservation", async () => {
    const { Reservation, ledger, book, consistent } = setup();
    const k = key();
    const [a, b] = await Promise.all([book({ idempotencyKey: k }), book({ idempotencyKey: k })]);
    expect(a.reservation._id).toBe(b.reservation._id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(Reservation.docs).toHaveLength(1);
    expect(ledger.rows).toHaveLength(3);
    consistent();
  });

  test("the same key for a different stay is refused, not replayed", async () => {
    const { book } = setup();
    const k = key();
    await book({ idempotencyKey: k });
    await expect(book({ idempotencyKey: k, out: D(14) })).rejects.toMatchObject({ code: "idempotency_key_reused", statusCode: 409 });
  });

  test("keys are per guest", async () => {
    const { Reservation, book } = setup();
    const k = key();
    await book({ idempotencyKey: k });
    await book({ idempotencyKey: k, guest: GUEST2, in: D(20), out: D(22) });
    expect(Reservation.docs).toHaveLength(2);
  });
});

describe("create: refusals leave nothing behind", () => {
  async function refused(over, ErrorClass, setupExtra, mutate) {
    const ctx = setup(setupExtra);
    if (mutate) mutate(ctx);
    await expect(ctx.book(over)).rejects.toBeInstanceOf(ErrorClass);
    expect(ctx.Reservation.docs).toHaveLength(0);
    expect(ctx.ledger.rows).toHaveLength(0);
    return ctx;
  }

  test("price changed: 409 with the new quote", async () => {
    const ctx = setup();
    try {
      await ctx.book({ expectedTotalMinor: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(PriceChangedError);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("price_changed");
      expect(err.quote.totalMinor).toBe(pricing.quote({ listing: ctx.listing, checkIn: D(10), checkOut: D(13), guests: 2 }).totalMinor);
      expect(ctx.ledger.rows).toHaveLength(0);
      return;
    }
    throw new Error("did not throw");
  });

  test("the host cannot book their own listing", () => refused({ guest: { _id: HOST._id } }, ForbiddenError));
  test("a suspended guest cannot book", () => refused({ guest: { _id: GUEST._id, status: "suspended" } }, ForbiddenError));
  test("no guest at all cannot book", () => refused({ guest: undefined }, ForbiddenError));
  test("a draft listing is not bookable", () => refused({}, NotFoundError, { status: "draft" }));
  test("an unpublished listing is not bookable", () => refused({}, NotFoundError, { status: "unpublished" }));
  test("a deleted listing is not bookable", () => refused({}, NotFoundError, { deletedAt: new Date() }));
  test("a listing with no host is not bookable", () => refused({}, NotFoundError, { owner: null }));
  test("an unknown listing is not bookable", () => refused({ listing: fakeId() }, NotFoundError));
  test("more guests than the capacity", () => refused({ guests: 5 }, ValidationError));
  test("below the minimum stay", () => refused({ out: D(11) }, ValidationError, { minNights: 2 }));
  test("above the maximum stay", () => refused({ out: D(30) }, ValidationError, { maxNights: 5 }));
  test("check-in in the past", () => refused({ in: D(-2), out: D(1) }, ValidationError));
  test("check-out not after check-in", () => refused({ in: D(10), out: D(10) }, ValidationError));
  test("a listing without a price is refused by the quote (422)", async () => {
    const ctx = setup({ pricing: {} });
    await expect(ctx.book()).rejects.toMatchObject({ statusCode: 422 });
    expect(ctx.ledger.rows).toHaveLength(0);
  });

  test.each([
    ["bad date", { in: "2026-02-30" }],
    ["date with time", { in: `${D(10)}T00:00:00Z` }],
    ["text guests", { guests: "two" }],
    ["zero guests", { guests: 0 }],
    ["fractional guests", { guests: 1.5 }],
    ["negative expected total", { expectedTotalMinor: -5 }],
    ["fractional expected total", { expectedTotalMinor: 10.5 }],
    ["short key", { idempotencyKey: "short" }],
    ["key with spaces", { idempotencyKey: "has spaces in it!" }],
    ["missing key", { idempotencyKey: undefined }],
  ])("%s is a validation error", (_name, over) => refused(over, ValidationError));

  test("nights taken by someone else: 409 and no reservation", async () => {
    const ctx = setup();
    await ctx.book({ guest: GUEST2 });
    await expect(ctx.book({ in: D(12), out: D(15) })).rejects.toMatchObject({ code: "nights_unavailable", statusCode: 409 });
    expect(ctx.Reservation.docs).toHaveLength(1);
    expect(findViolations(ctx.Reservation.docs, ctx.ledger.rows)).toEqual([]);
  });

  test("the host unpublishes while the request is in flight: nights are released", async () => {
    const ctx = setup();
    // The first read returns the published listing; the re-check after the
    // nights are held sees the change.
    ctx.Listing.afterFirstRead = (found) => {
      ctx.Listing.listings[0] = { ...found, status: "unpublished" };
    };
    await expect(ctx.book()).rejects.toBeInstanceOf(NotFoundError);
    expect(ctx.ledger.rows).toHaveLength(0);
    expect(ctx.Reservation.docs).toHaveLength(0);
  });

  test("the reservation insert fails: nights are released and the error is the original", async () => {
    const ctx = setup();
    ctx.Reservation.createFailure = new Error("disk full");
    await expect(ctx.book()).rejects.toThrow("disk full");
    expect(ctx.ledger.rows).toHaveLength(0);
  });

  test("a failing release does not hide the original error", async () => {
    const ctx = setup();
    ctx.Reservation.createFailure = new Error("disk full");
    ctx.ledger.failRelease = true;
    await expect(ctx.book()).rejects.toThrow("disk full");
  });
});

describe("transition", () => {
  const by = (id) => ({ by: id });

  async function pendingBooking(extra) {
    const ctx = setup(extra);
    const { reservation } = await ctx.book();
    return { ...ctx, reservation };
  }

  test("host accepts: confirmed, hold removed from the reservation and the nights", async () => {
    const { service, reservation, ledger, consistent } = await pendingBooking();
    const updated = await service.transition(reservation._id, "confirmed", { actor: "host", ...by(HOST._id), now: NOW });
    expect(updated.status).toBe("confirmed");
    expect(updated.holdExpiresAt).toBeUndefined();
    expect(updated.statusHistory.map((h) => h.to)).toEqual(["pending", "confirmed"]);
    expect(ledger.rows.some((r) => r.holdExpiresAt)).toBe(false);
    expect(ledger.rows).toHaveLength(3);
    consistent();
  });

  test.each([
    ["host declines", "declined", "host"],
    ["guest cancels a request", "cancelled_by_guest", "guest"],
  ])("%s: nights are released", async (_n, to, actor) => {
    const { service, reservation, ledger, consistent } = await pendingBooking();
    const updated = await service.transition(reservation._id, to, { actor, reason: "changed plans", now: NOW });
    expect(updated.status).toBe(to);
    expect(ledger.rows).toHaveLength(0);
    consistent();
  });

  test("a cancellation records who and why", async () => {
    const { service, reservation } = await pendingBooking();
    const updated = await service.transition(reservation._id, "cancelled_by_guest", { actor: "guest", reason: "changed plans", now: NOW });
    expect(updated.cancelledBy).toBe("guest");
    expect(updated.cancelReason).toBe("changed plans");
  });

  test("host cancels a confirmed booking: nights released", async () => {
    const { service, ledger, book } = setup({ instantBook: true });
    const { reservation } = await book();
    await service.transition(reservation._id, "cancelled_by_host", { actor: "host", now: NOW });
    expect(ledger.rows).toHaveLength(0);
  });

  test("accepting after the hold ran out is refused", async () => {
    const { service, reservation } = await pendingBooking();
    const later = new Date(NOW.getTime() + PENDING_HOLD_MS + 1000);
    await expect(service.transition(reservation._id, "confirmed", { actor: "host", now: later })).rejects.toMatchObject({ code: "hold_expired" });
  });

  test("the sweeper can expire only a request whose hold ran out", async () => {
    const { service, reservation, ledger, consistent } = await pendingBooking();
    await expect(service.transition(reservation._id, "expired", { actor: "system", now: NOW })).rejects.toMatchObject({ code: "hold_active" });
    const later = new Date(NOW.getTime() + PENDING_HOLD_MS + 1000);
    const updated = await service.transition(reservation._id, "expired", { actor: "system", now: later });
    expect(updated.status).toBe("expired");
    expect(ledger.rows).toHaveLength(0);
    consistent();
  });

  test("completed only once the check-out date has passed; its nights stay", async () => {
    const { service, reservation, ledger, consistent } = await (async () => {
      const ctx = setup({ instantBook: true });
      const { reservation: r } = await ctx.book();
      return { ...ctx, reservation: r };
    })();
    await expect(service.transition(reservation._id, "completed", { actor: "system", now: NOW })).rejects.toMatchObject({ code: "stay_not_over" });
    const after = new Date(NOW.getTime() + 20 * 86400000);
    const updated = await service.transition(reservation._id, "completed", { actor: "system", now: after });
    expect(updated.status).toBe("completed");
    expect(ledger.rows).toHaveLength(3);
    consistent();
  });

  test("wrong actor, terminal status and unknown reservation", async () => {
    const { service, reservation } = await pendingBooking();
    await expect(service.transition(reservation._id, "confirmed", { actor: "guest", now: NOW })).rejects.toBeInstanceOf(InvalidTransitionError);
    await service.transition(reservation._id, "declined", { actor: "host", now: NOW });
    await expect(service.transition(reservation._id, "confirmed", { actor: "host", now: NOW })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(service.transition(fakeId(), "confirmed", { actor: "host", now: NOW })).rejects.toBeInstanceOf(NotFoundError);
  });

  test("host accepts while the guest cancels: exactly one wins and the ledger agrees", async () => {
    for (let i = 0; i < 20; i += 1) {
      const { service, reservation, Reservation, ledger } = await pendingBooking();
      const results = await Promise.allSettled([
        service.transition(reservation._id, "confirmed", { actor: "host", now: NOW }),
        service.transition(reservation._id, "cancelled_by_guest", { actor: "guest", now: NOW }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((r) => r.status === "rejected").reason;
      expect(failure).toBeInstanceOf(ConflictError);
      expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]);
    }
  });
});

describe("invariant checker", () => {
  const day = (n) => addDays(TODAY, n);
  const res = (over) => ({ _id: "r1", listing: "L", checkIn: day(1), checkOut: day(3), status: "confirmed", ...over });
  const row = (n, over) => ({ listing: "L", date: day(n), source: { kind: "reservation", id: "r1" }, ...over });

  test("a consistent state has no violations", () => {
    expect(findViolations([res()], [row(1), row(2)])).toEqual([]);
  });

  test("catches each kind of inconsistency", () => {
    expect(findViolations([res()], [row(1)]).join()).toMatch(/\(b\)/); // missing night
    expect(findViolations([res()], [row(1), row(2), row(1)]).join()).toMatch(/\(a\)/); // owned twice
    expect(findViolations([res({ status: "declined" })], [row(1), row(2)]).join()).toMatch(/\(c\)/); // rows of a released reservation
    expect(findViolations([], [row(1)]).join()).toMatch(/\(c\)/); // orphan rows
    expect(findViolations([res({ status: "pending" })], [row(1), row(2)]).join()).toMatch(/\(d\)/); // pending without a hold
    expect(findViolations([res({ holdExpiresAt: day(5) })], [row(1), row(2)]).join()).toMatch(/\(d\)/); // confirmed with a hold
  });

  test("host blocks are not reservations", () => {
    expect(findViolations([], [row(1, { source: { kind: "block", id: "b1" } })])).toEqual([]);
  });
});

describe("create: booking rules (P07-T06)", () => {
  // 15:00 on 20 Oct 2026 in Kolkata.
  const LATE = new Date("2026-10-20T09:30:00Z");
  const stay = (over = {}) => ({ in: "2026-10-21", out: "2026-10-23", guests: 2, ...over });
  async function bookAt(now, over, extra) {
    const ctx = setup(extra);
    const promise = ctx.service.create({ guest: GUEST, listing: ctx.listing._id, idempotencyKey: key(), ...stay(over) }, { now });
    return { ctx, promise };
  }
  async function refusedWith(code, now, over, extra) {
    const { ctx, promise } = await bookAt(now, over, extra);
    await expect(promise).rejects.toMatchObject({ statusCode: 400, code });
    expect(ctx.Reservation.docs).toHaveLength(0);
    expect(ctx.ledger.rows).toHaveLength(0);
  }

  test("not enough notice: 400 with its own code, nothing held", () =>
    refusedWith("advance_notice", LATE, {}, { advanceNoticeHours: 24 })); // 14:00 tomorrow is 23 h away
  test("enough notice is accepted", async () => {
    const { ctx, promise } = await bookAt(LATE, { in: "2026-10-22", out: "2026-10-24" }, { advanceNoticeHours: 24 });
    const { reservation } = await promise;
    expect(reservation.status).toBe("pending");
    ctx.consistent();
  });
  test("same-day booking after the cut-off: 400 and nothing held", () =>
    refusedWith("same_day_cutoff", LATE, { in: "2026-10-20", out: "2026-10-21" }, { sameDayCutoffTime: "14:00" }));
  test("same-day booking before the cut-off is accepted", async () => {
    const { ctx, promise } = await bookAt(LATE, { in: "2026-10-20", out: "2026-10-21" });
    await expect(promise).resolves.toMatchObject({ created: true });
    ctx.consistent();
  });
  test("each other rule keeps its own code", async () => {
    await refusedWith("over_capacity", LATE, { guests: 9 });
    await refusedWith("below_min_nights", LATE, { out: "2026-10-22" }, { minNights: 2 });
    await refusedWith("above_max_nights", LATE, { out: "2026-11-30" });
    await refusedWith("check_in_past", LATE, { in: "2026-10-19", out: "2026-10-21" });
    await refusedWith("check_in_too_far", LATE, { in: "2027-10-21", out: "2027-10-23" });
    await refusedWith("check_out_not_after_check_in", LATE, { out: "2026-10-21" });
  });
  test("a replayed booking is not re-judged by the rules", async () => {
    const ctx = setup();
    const k = key();
    const first = await ctx.service.create({ guest: GUEST, listing: ctx.listing._id, idempotencyKey: k, ...stay() }, { now: LATE });
    const strict = { advanceNoticeHours: 168 };
    Object.assign(ctx.listing, strict); // the host tightens the rules afterwards
    const again = await ctx.service.create({ guest: GUEST, listing: ctx.listing._id, idempotencyKey: k, ...stay() }, { now: LATE });
    expect(again.created).toBe(false);
    expect(again.reservation._id).toBe(first.reservation._id);
  });
});
