// P09-T04: changing the dates of a booking, against in-memory fakes (no
// database). Real MongoDB behaviour (unique index, races) is covered by
// tests/integration/modifications.db.test.js. Every test that changes the
// ledger ends by checking the ledger/reservation invariants.
const { createReservationService, PENDING_HOLD_MS } = require("../../src/services/reservations");
const {
  createModificationService,
  modifiability,
  diffNights,
  describeDifference,
} = require("../../src/services/modifications");
const pricing = require("../../src/services/pricing");
const { todayIn, addDays, formatDateOnly, parseDateOnly } = require("../../src/utils/dates");
const {
  ValidationError,
  NotFoundError,
  ConflictError,
  PriceChangedError,
} = require("../../src/utils/errors");
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
const HOST = { _id: fakeId(), status: "active" };
const GUEST = { _id: fakeId(), status: "active" };
const OTHER = { _id: fakeId(), status: "active" };
let keyN = 0;
const key = () => `key-${(keyN += 1)}-abcdefgh`;

function setup(listingExtra = {}) {
  const Reservation = new FakeReservationModel();
  const listing = {
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
    instantBook: true,
    cancellationPolicy: "moderate",
    checkInTime: "14:00",
    checkOutTime: "11:00",
    timezone: "Asia/Kolkata",
    houseRules: "No parties",
    images: [{ url: "https://img/x.jpg" }],
    ...listingExtra,
  };
  const Listing = new FakeListingModel([listing]);
  const ledger = new FakeLedger();
  const reservations = createReservationService({
    ReservationModel: Reservation,
    ListingModel: Listing,
    ledgerService: ledger,
    pricing,
    newId: fakeId,
  });
  const events = [];
  const logged = [];
  const service = createModificationService({
    ReservationModel: Reservation,
    ListingModel: Listing,
    ledgerService: ledger,
    pricing,
    notifier: { dispatch: async (event, ctx) => events.push([event, ctx.reservation]) },
    logger: { error: (...args) => logged.push(args) },
  });
  const book = async (over = {}) =>
    (
      await reservations.create(
        { guest: GUEST, listing: listing._id, in: D(10), out: D(13), guests: 2, idempotencyKey: key(), ...over },
        { now: NOW },
      )
    ).reservation;
  const change = (reservation, over = {}) =>
    service.changeDates({ id: String(reservation._id), user: GUEST, in: D(12), out: D(15), now: NOW, ...over });
  const consistent = () => expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]);
  const nightsOf = (reservation) =>
    ledger.rows
      .filter((r) => String(r.source.id) === String(reservation._id))
      .map((r) => formatDateOnly(r.date))
      .sort();
  return { Reservation, Listing, ledger, listing, service, reservations, book, change, consistent, nightsOf, events, logged };
}

describe("pure helpers", () => {
  test("diffNights: nights to add and to give up", () => {
    const d = diffNights(parseDateOnly("2099-06-10"), parseDateOnly("2099-06-13"), parseDateOnly("2099-06-12"), parseDateOnly("2099-06-15"));
    expect(d.added.map(formatDateOnly)).toEqual(["2099-06-13", "2099-06-14"]);
    expect(d.removed.map(formatDateOnly)).toEqual(["2099-06-10", "2099-06-11"]);
    expect(d.after.map(formatDateOnly)).toEqual(["2099-06-12", "2099-06-13", "2099-06-14"]);
  });

  test("describeDifference: more, less, same", () => {
    const formatMoney = (minor) => `Rs ${minor / 100}`;
    expect(describeDifference(50000, { formatMoney, currency: "INR" })).toEqual({ kind: "more", amountText: "Rs 500", text: "The new stay costs Rs 500 more." });
    expect(describeDifference(-50000, { formatMoney, currency: "INR" }).kind).toBe("less");
    expect(describeDifference(0, { formatMoney, currency: "INR" }).kind).toBe("same");
  });

  test("modifiability: statuses, hold and the check-in moment", () => {
    const base = {
      status: "confirmed",
      checkIn: parseDateOnly("2099-06-10"),
      checkOut: parseDateOnly("2099-06-13"),
      listingSnapshot: { checkInTime: "14:00", timezone: "Asia/Kolkata" },
    };
    expect(modifiability(base, NOW)).toEqual({ ok: true });
    expect(modifiability({ ...base, status: "declined" }, NOW).code).toBe("not_modifiable");
    expect(modifiability({ ...base, status: "completed" }, NOW).code).toBe("not_modifiable");
    expect(modifiability({ ...base, status: "pending" }, NOW).code).toBe("hold_expired");
    expect(modifiability({ ...base, status: "pending", holdExpiresAt: new Date(NOW.getTime() + 1000) }, NOW).ok).toBe(true);
    const started = { ...base, checkIn: parseDateOnly("2020-06-10"), checkOut: parseDateOnly("2020-06-13") };
    expect(modifiability(started, NOW).code).toBe("stay_started");
  });

  test("modifiability: the exact check-in instant (14:00 on the listing's clock) is already too late", () => {
    const base = {
      status: "confirmed",
      checkIn: parseDateOnly("2099-06-10"),
      checkOut: parseDateOnly("2099-06-13"),
      listingSnapshot: { checkInTime: "14:00", timezone: "Asia/Kolkata" },
    };
    const at = new Date("2099-06-10T08:30:00Z"); // 14:00 in Kolkata
    expect(modifiability(base, new Date(at.getTime() - 1)).ok).toBe(true);
    expect(modifiability(base, at).code).toBe("stay_started");
  });
});

describe("changeDates: a confirmed stay", () => {
  test("moves the stay: new nights held, old ones released, price and history recorded", async () => {
    const { ledger, book, change, consistent, nightsOf, events } = setup();
    const booking = await book();
    const oldTotal = booking.pricingSnapshot.totalMinor; // the fake updates the stored object in place
    expect(nightsOf(booking)).toEqual([D(10), D(11), D(12)]);

    const result = await change(booking, { in: D(12), out: D(15) });
    expect(result.reapproval).toBe(false);
    expect(nightsOf(booking)).toEqual([D(12), D(13), D(14)]);
    expect(ledger.rows).toHaveLength(3);
    expect(result.reservation.status).toBe("confirmed");
    expect(formatDateOnly(result.reservation.checkIn)).toBe(D(12));
    expect(formatDateOnly(result.reservation.checkOut)).toBe(D(15));
    expect(result.reservation.nights).toBe(3);
    expect(result.reservation.holdExpiresAt).toBeUndefined();
    expect(result.reservation.guests).toBe(2);
    consistent();

    expect(result.reservation.modifications).toHaveLength(1);
    const m = result.reservation.modifications[0];
    expect(formatDateOnly(m.from.checkIn)).toBe(D(10));
    expect(formatDateOnly(m.to.checkIn)).toBe(D(12));
    expect(m.from.totalMinor).toBe(oldTotal);
    expect(m.to.totalMinor).toBe(result.quote.totalMinor);
    expect(m.differenceMinor).toBe(result.quote.totalMinor - m.from.totalMinor);
    expect(m.reapproval).toBe(false);

    const last = result.reservation.statusHistory[result.reservation.statusHistory.length - 1];
    expect(last.from).toBe("confirmed");
    expect(last.to).toBe("confirmed");
    expect(last.actor).toBe("guest");
    expect(last.note).toContain(D(12));
    expect(events.map(([e]) => e)).toEqual(["reservation.modified"]);
  });

  test("the stored snapshot is exactly today's quote for the new dates", async () => {
    const { listing, book, change } = setup();
    const booking = await book();
    const oldTotal = booking.pricingSnapshot.totalMinor;
    const result = await change(booking, { in: D(20), out: D(22) });
    const quote = pricing.quote({ listing, checkIn: D(20), checkOut: D(22), guests: 2 });
    expect(result.reservation.pricingSnapshot).toEqual(quote);
    expect(result.differenceMinor).toBe(quote.totalMinor - oldTotal);
    expect(result.differenceMinor).toBeLessThan(0); // two nights cost less than three
  });

  test("a shorter stay inside the old one only gives nights up", async () => {
    const { book, change, consistent, nightsOf } = setup();
    const booking = await book();
    const result = await change(booking, { in: D(10), out: D(12) });
    expect(nightsOf(booking)).toEqual([D(10), D(11)]);
    expect(result.differenceMinor).toBeLessThan(0);
    consistent();
  });

  test("a longer stay around the old one only adds nights", async () => {
    const { book, change, consistent, nightsOf } = setup();
    const booking = await book();
    const result = await change(booking, { in: D(9), out: D(14) });
    expect(nightsOf(booking)).toEqual([D(9), D(10), D(11), D(12), D(13)]);
    expect(result.differenceMinor).toBeGreaterThan(0);
    consistent();
  });

  test("the price the guest saw must still be the price: otherwise nothing changes", async () => {
    const { ledger, book, change, events } = setup();
    const booking = await book();
    const before = JSON.stringify(ledger.rows);
    await expect(change(booking, { expectedTotalMinor: 1 })).rejects.toBeInstanceOf(PriceChangedError);
    expect(JSON.stringify(ledger.rows)).toBe(before);
    expect(booking.modifications).toBeUndefined();
    expect(events).toEqual([]);
  });

  test("the expected total, when right, is accepted (also as a string from a form)", async () => {
    const { listing, book, change } = setup();
    const booking = await book();
    const total = pricing.quote({ listing, checkIn: D(12), checkOut: D(15), guests: 2 }).totalMinor;
    const result = await change(booking, { expectedTotalMinor: String(total) });
    expect(result.quote.totalMinor).toBe(total);
  });

  test("nights someone else holds: refused, and the booking is exactly as before", async () => {
    const { ledger, book, change, consistent, nightsOf, events } = setup();
    const booking = await book();
    await book({ in: D(14), out: D(16), idempotencyKey: key() }); // a second booking holds 14 and 15
    const before = JSON.stringify(ledger.rows);
    const error = await change(booking, { in: D(12), out: D(15) }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("nights_unavailable");
    expect(JSON.stringify(ledger.rows)).toBe(before);
    expect(nightsOf(booking)).toEqual([D(10), D(11), D(12)]);
    expect(formatDateOnly(booking.checkIn)).toBe(D(10));
    expect(booking.modifications).toBeUndefined();
    expect(events).toEqual([]);
    consistent();
  });

  test("a conflict found only when the nights are held (a race after the check) changes nothing either", async () => {
    const { ledger, book, change, consistent, nightsOf, service } = setup();
    const booking = await book();
    await book({ in: D(14), out: D(16), idempotencyKey: key() });
    const real = ledger.unavailableDates.bind(ledger);
    ledger.unavailableDates = async () => []; // the advance check saw nothing
    const before = JSON.stringify(ledger.rows);
    const error = await change(booking, { in: D(12), out: D(15) }).catch((e) => e);
    ledger.unavailableDates = real;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("nights_unavailable");
    expect(JSON.stringify(ledger.rows)).toBe(before);
    expect(nightsOf(booking)).toEqual([D(10), D(11), D(12)]);
    expect(service).toBeDefined();
    consistent();
  });

  test("its own nights never count against it (moving by one day over the same nights)", async () => {
    const { book, change, nightsOf } = setup();
    const booking = await book();
    await change(booking, { in: D(11), out: D(14) });
    expect(nightsOf(booking)).toEqual([D(11), D(12), D(13)]);
  });

  test("the booking changed meanwhile (compare-and-set lost): the added nights are released, the booking is untouched", async () => {
    const { Reservation, ledger, book, change, consistent, nightsOf, events } = setup();
    const booking = await book();
    const original = Reservation.findOneAndUpdate.bind(Reservation);
    Reservation.findOneAndUpdate = async (filter, update) => {
      booking.status = "cancelled_by_guest"; // somebody cancelled between our read and our write
      return original(filter, update);
    };
    const error = await change(booking, { in: D(12), out: D(15) }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("conflict");
    expect(nightsOf(booking)).toEqual([D(10), D(11), D(12)]); // only the old nights; D(13), D(14) were released again
    expect(ledger.rows).toHaveLength(3);
    expect(booking.modifications).toBeUndefined();
    expect(events).toEqual([]);
    expect(consistent).toBeDefined();
  });

  test("two changes at the same moment: exactly one wins and the ledger follows the winner", async () => {
    const { ledger, book, service, consistent, nightsOf } = setup();
    const booking = await book();
    const run = (inDay, outDay) =>
      service
        .changeDates({ id: String(booking._id), user: GUEST, in: D(inDay), out: D(outDay), now: NOW })
        .then(() => "won", (e) => e);
    const [a, b] = await Promise.all([run(12, 15), run(7, 10)]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
    const loser = outcomes.find((o) => o !== "won");
    expect(loser).toBeInstanceOf(ConflictError);
    expect(ledger.rows).toHaveLength(3);
    const won = a === "won" ? [D(12), D(13), D(14)] : [D(7), D(8), D(9)];
    expect(nightsOf(booking)).toEqual(won);
    expect(booking.modifications).toHaveLength(1);
    consistent();
  });

  test("two changes that want the same new night: one wins, the other is refused", async () => {
    const { book, service, consistent } = setup();
    const booking = await book();
    const run = (inDay, outDay) =>
      service
        .changeDates({ id: String(booking._id), user: GUEST, in: D(inDay), out: D(outDay), now: NOW })
        .then(() => "won", (e) => e);
    const results = await Promise.all([run(12, 15), run(13, 16)]);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    consistent();
  });

  test("giving the old nights up fails: the change stands, the old nights stay blocked (safe side) and a second trim repairs it", async () => {
    const { ledger, book, change, nightsOf, logged } = setup();
    const booking = await book();
    ledger.failTrim = true;
    const result = await change(booking, { in: D(12), out: D(15) });
    expect(formatDateOnly(result.reservation.checkIn)).toBe(D(12));
    expect(nightsOf(booking)).toEqual([D(10), D(11), D(12), D(13), D(14)]);
    expect(logged).toHaveLength(1);
    ledger.failTrim = false;
    await ledger.trimNights(booking._id, [parseDateOnly(D(12)), parseDateOnly(D(13)), parseDateOnly(D(14))]);
    expect(nightsOf(booking)).toEqual([D(12), D(13), D(14)]);
  });
});

describe("changeDates: a pending request goes back to the host", () => {
  const pendingSetup = () => setup({ instantBook: false });

  test("the hold restarts for 24 hours on every night, the request stays pending and the host is told", async () => {
    const later = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    const { ledger, book, service, consistent, nightsOf, events } = pendingSetup();
    const booking = await book();
    expect(booking.status).toBe("pending");
    const result = await service.changeDates({ id: String(booking._id), user: GUEST, in: D(12), out: D(15), now: later });
    expect(result.reapproval).toBe(true);
    expect(result.reservation.status).toBe("pending");
    expect(result.reservation.holdExpiresAt.getTime()).toBe(later.getTime() + PENDING_HOLD_MS);
    expect(nightsOf(booking)).toEqual([D(12), D(13), D(14)]);
    expect(ledger.rows.every((r) => r.holdExpiresAt.getTime() === later.getTime() + PENDING_HOLD_MS)).toBe(true);
    expect(result.reservation.modifications[0].reapproval).toBe(true);
    expect(events.map(([e]) => e)).toEqual(["reservation.modified"]);
    consistent();
  });

  test("an expired request cannot be changed", async () => {
    const { book, service } = pendingSetup();
    const booking = await book();
    const after = new Date(NOW.getTime() + PENDING_HOLD_MS + 1000);
    const error = await service.changeDates({ id: String(booking._id), user: GUEST, in: D(12), out: D(15), now: after }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("hold_expired");
  });

  test("the hold of the kept nights cannot be moved: the added nights are released again and nothing changes", async () => {
    const { ledger, book, change, consistent, nightsOf } = pendingSetup();
    const booking = await book();
    const holdBefore = booking.holdExpiresAt.getTime();
    ledger.failExtend = true;
    await expect(change(booking, { in: D(12), out: D(15) })).rejects.toThrow("extend failed");
    expect(nightsOf(booking)).toEqual([D(10), D(11), D(12)]);
    expect(booking.holdExpiresAt.getTime()).toBe(holdBefore);
    expect(booking.modifications).toBeUndefined();
    consistent();
  });
});

describe("changeDates: who and when", () => {
  test("only the guest of the booking: the host, a stranger, a missing or malformed id all get the same 404", async () => {
    const { book, service } = setup();
    const booking = await book();
    const ask = (user, id = String(booking._id)) =>
      service.changeDates({ id, user, in: D(12), out: D(15), now: NOW }).catch((e) => e);
    for (const outcome of [await ask(HOST), await ask(OTHER), await ask(GUEST, "f".repeat(24)), await ask(GUEST, "nope")]) {
      expect(outcome).toBeInstanceOf(NotFoundError);
    }
  });

  test("a suspended guest cannot change anything", async () => {
    const { book, service } = setup();
    const booking = await book();
    const error = await service.changeDates({ id: String(booking._id), user: { ...GUEST, status: "suspended" }, in: D(12), out: D(15), now: NOW }).catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
  });

  test("a declined, cancelled or finished booking is refused", async () => {
    const { book, change } = setup();
    const statuses = ["declined", "expired", "cancelled_by_guest", "cancelled_by_host", "completed"];
    for (const [i, status] of statuses.entries()) {
      const booking = await book({ idempotencyKey: key(), in: D(30 + i * 5), out: D(32 + i * 5) });
      booking.status = status;
      const error = await change(booking).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.code).toBe("not_modifiable");
    }
  });

  test("a stay that has started cannot be moved", async () => {
    const { Reservation, book, change } = setup();
    const booking = await book();
    booking.checkIn = parseDateOnly(D(-1));
    booking.checkOut = parseDateOnly(D(2));
    expect(Reservation.docs).toHaveLength(1);
    const error = await change(booking).catch((e) => e);
    expect(error.code).toBe("stay_started");
  });

  test("a place that is not public any more cannot take the change", async () => {
    const { listing, book, change } = setup();
    const booking = await book();
    listing.status = "unpublished";
    const error = await change(booking).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("listing_unavailable");
  });
});

describe("changeDates: the booking rules apply to the new dates", () => {
  test("the same dates are not a change", async () => {
    const { book, change } = setup();
    const booking = await book();
    const error = await change(booking, { in: D(10), out: D(13) }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("no_change");
  });

  test("missing, malformed or non-text dates", async () => {
    const { book, change } = setup();
    const booking = await book();
    for (const bad of [{ in: undefined }, { out: "" }, { in: "2099-02-30" }, { in: ["2099-01-01"] }, { out: { $gt: "" } }]) {
      const error = await change(booking, bad).catch((e) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe("invalid_dates");
    }
  });

  test("check-in in the past, too short, too long, too far ahead", async () => {
    const { book, change } = setup({ minNights: 2, maxNights: 5 });
    const booking = await book({ in: D(10), out: D(13) });
    const code = async (over) => (await change(booking, over).catch((e) => e)).code;
    expect(await code({ in: D(-2), out: D(1) })).toBe("check_in_past");
    expect(await code({ in: D(20), out: D(21) })).toBe("below_min_nights");
    expect(await code({ in: D(20), out: D(26) })).toBe("above_max_nights");
    expect(await code({ in: D(900), out: D(902) })).toBe("check_in_too_far");
  });

  test("advance notice set by the host applies to the new check-in", async () => {
    const { book, change } = setup({ advanceNoticeHours: 72 });
    const booking = await book({ in: D(10), out: D(13) });
    const error = await change(booking, { in: D(1), out: D(3) }).catch((e) => e);
    expect(error.code).toBe("advance_notice");
  });
});

describe("previewChange", () => {
  test("without dates: just the form", async () => {
    const { book, service } = setup();
    const booking = await book();
    const preview = await service.previewChange({ id: String(booking._id), user: GUEST, now: NOW });
    expect(preview.requested).toBe(false);
    expect(preview.quote).toBeNull();
    expect(preview.problems).toEqual([]);
  });

  test("with dates: the new quote and the difference, and nothing is written", async () => {
    const { ledger, book, service } = setup();
    const booking = await book();
    const oldTotal = booking.pricingSnapshot.totalMinor;
    const before = JSON.stringify(ledger.rows);
    const preview = await service.previewChange({ id: String(booking._id), user: GUEST, in: D(20), out: D(24), now: NOW });
    expect(preview.requested).toBe(true);
    expect(preview.problems).toEqual([]);
    expect(preview.quote.nights).toBe(4);
    expect(preview.differenceMinor).toBe(preview.quote.totalMinor - oldTotal);
    expect(preview.reapproval).toBe(false);
    expect(JSON.stringify(ledger.rows)).toBe(before);
    expect(booking.modifications).toBeUndefined();
  });

  test("taken nights come back as a problem without a price; the booking's own nights are free", async () => {
    const { book, service } = setup();
    const booking = await book();
    await book({ in: D(14), out: D(16), idempotencyKey: key() });
    const taken = await service.previewChange({ id: String(booking._id), user: GUEST, in: D(12), out: D(15), now: NOW });
    expect(taken.problems.map((p) => p.code)).toEqual(["nights_unavailable"]);
    expect(taken.quote).toBeNull();
    const own = await service.previewChange({ id: String(booking._id), user: GUEST, in: D(11), out: D(13), now: NOW });
    expect(own.problems).toEqual([]);
  });

  test("a pending request says it needs the host again", async () => {
    const { book, service } = setup({ instantBook: false });
    const booking = await book();
    const preview = await service.previewChange({ id: String(booking._id), user: GUEST, in: D(12), out: D(15), now: NOW });
    expect(preview.reapproval).toBe(true);
  });

  test("a booking that cannot be changed is a 409, someone else's is a 404", async () => {
    const { book, service } = setup();
    const booking = await book();
    booking.status = "cancelled_by_guest";
    await expect(service.previewChange({ id: String(booking._id), user: GUEST, now: NOW })).rejects.toBeInstanceOf(ConflictError);
    await expect(service.previewChange({ id: String(booking._id), user: OTHER, now: NOW })).rejects.toBeInstanceOf(NotFoundError);
  });
});
