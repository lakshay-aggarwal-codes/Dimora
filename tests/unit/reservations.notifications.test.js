// P11-T04: the reservation service tells the right people after each change,
// and a notification problem never changes the booking's result. In-memory
// fakes, no database.
const { createReservationService } = require("../../src/services/reservations");
const pricing = require("../../src/services/pricing");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");
const { FakeReservationModel, FakeListingModel, FakeLedger, fakeId } = require("../helpers/fakeReservationDeps");

const NOW = new Date();
const TODAY = todayIn("Asia/Kolkata", NOW);
const D = (n) => formatDateOnly(addDays(TODAY, n));
const HOST = { _id: fakeId() };
const GUEST = { _id: fakeId(), status: "active" };

function setup({ instantBook = false, notifier } = {}) {
  const sent = [];
  const recorder = { dispatch: async (event, ctx) => void sent.push([event, ctx.reservation]) };
  const listing = {
    _id: fakeId(), owner: HOST._id, status: "published", deletedAt: null, title: "Sea house",
    address: { city: "Goa" }, pricing: { nightlyMinor: 250000, cleaningFeeMinor: 50000, currency: "INR" },
    capacity: { guests: 4 }, minNights: 1, maxNights: 14, instantBook, cancellationPolicy: "moderate",
    checkInTime: "14:00", checkOutTime: "11:00", timezone: "Asia/Kolkata", houseRules: "No parties", images: [],
  };
  const Reservation = new FakeReservationModel();
  const service = createReservationService({
    ReservationModel: Reservation, ListingModel: new FakeListingModel([listing]), ledgerService: new FakeLedger(),
    pricing, newId: fakeId, notifier: notifier === undefined ? recorder : notifier,
  });
  let n = 0;
  const book = () =>
    service.create({ guest: GUEST, listing: listing._id, in: D(10), out: D(13), guests: 2, idempotencyKey: `key-${(n += 1)}-abcdefgh` }, { now: NOW });
  return { service, sent, book, Reservation };
}

const later = (days) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

describe("creating a booking", () => {
  test("a request tells the host once", async () => {
    const { book, sent } = setup();
    const { reservation } = await book();
    expect(sent.map((s) => s[0])).toEqual(["reservation.requested"]);
    expect(String(sent[0][1]._id)).toBe(String(reservation._id));
  });

  test("an instant booking tells the host it was booked", async () => {
    const { book, sent } = setup({ instantBook: true });
    await book();
    expect(sent.map((s) => s[0])).toEqual(["reservation.booked"]);
  });

  test("a repeated request (same key) does not notify again", async () => {
    const { service, sent, book } = setup();
    const first = await book();
    const again = await service.create(
      { guest: GUEST, listing: first.reservation.listing, in: D(10), out: D(13), guests: 2, idempotencyKey: first.reservation.idempotencyKey },
      { now: NOW },
    );
    expect(again.created).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("a refused booking notifies nobody", async () => {
    const { service, sent } = setup();
    await expect(
      service.create({ guest: GUEST, listing: fakeId(), in: D(10), out: D(13), guests: 2, idempotencyKey: "key-0-abcdefgh" }, { now: NOW }),
    ).rejects.toBeTruthy();
    expect(sent).toHaveLength(0);
  });
});

describe("changing a booking", () => {
  test.each([
    ["confirmed", "host", "reservation.accepted", 0],
    ["declined", "host", "reservation.declined", 0],
    ["cancelled_by_guest", "guest", "reservation.cancelled", 0],
    ["expired", "system", "reservation.expired", 2],
  ])("pending -> %s tells with %s", async (to, actor, event, daysLater) => {
    const { book, service, sent } = setup();
    const { reservation } = await book();
    sent.length = 0;
    const updated = await service.transition(reservation._id, to, { actor, now: later(daysLater) });
    expect(sent.map((s) => s[0])).toEqual([event]);
    expect(sent[0][1].status).toBe(to);
    expect(String(sent[0][1]._id)).toBe(String(updated._id));
  });

  test("a host's cancellation carries who cancelled, so the guest is the one told", async () => {
    const { book, service, sent } = setup({ instantBook: true });
    const { reservation } = await book();
    sent.length = 0;
    await service.transition(reservation._id, "cancelled_by_host", { actor: "host", reason: "Pipe burst", now: NOW });
    expect(sent[0][0]).toBe("reservation.cancelled");
    expect(sent[0][1].cancelledBy).toBe("host");
    expect(sent[0][1].cancelReason).toBe("Pipe burst");
  });

  test("a finished stay tells the guest a review is available", async () => {
    const { book, service, sent } = setup({ instantBook: true });
    const { reservation } = await book();
    sent.length = 0;
    await service.transition(reservation._id, "completed", { actor: "system", now: later(20) });
    expect(sent.map((s) => s[0])).toEqual(["review.available"]);
  });

  test("a refused change (wrong actor, too early, lost race) notifies nobody", async () => {
    const { book, service, sent } = setup();
    const { reservation } = await book();
    sent.length = 0;
    await expect(service.transition(reservation._id, "confirmed", { actor: "guest", now: NOW })).rejects.toBeTruthy();
    await expect(service.transition(reservation._id, "expired", { actor: "system", now: NOW })).rejects.toBeTruthy();
    await service.transition(reservation._id, "declined", { actor: "host", now: NOW });
    sent.length = 0;
    await expect(service.transition(reservation._id, "confirmed", { actor: "host", now: NOW })).rejects.toBeTruthy();
    expect(sent).toHaveLength(0);
  });
});

describe("a notification problem never changes the result", () => {
  const broken = { dispatch: async () => { throw new Error("boom"); } };

  test("create still succeeds", async () => {
    const { book, Reservation } = setup({ notifier: broken });
    const { reservation, created } = await book();
    expect(created).toBe(true);
    expect(Reservation.docs).toHaveLength(1);
    expect(reservation.status).toBe("pending");
  });

  test("a transition still succeeds", async () => {
    const { book, service } = setup({ notifier: broken });
    const { reservation } = await book();
    const updated = await service.transition(reservation._id, "confirmed", { actor: "host", now: NOW });
    expect(updated.status).toBe("confirmed");
  });

  test("no notifier at all (a service built without one) sends nothing and works", async () => {
    const { book, service } = setup({ notifier: null });
    const { reservation } = await book();
    expect((await service.transition(reservation._id, "declined", { actor: "host", now: NOW })).status).toBe("declined");
  });
});
