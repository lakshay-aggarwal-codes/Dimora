// P11-T04: the sweeper's "check-in tomorrow" step. In-memory fakes, no database.
// Time is moved with `now`, never waited for.
const { createSweeper } = require("../../src/services/sweeper");
const { fakeCollection } = require("../helpers/fakeCollection");

// 2026-11-10 20:00 UTC = Nov 10 15:00 in New York, Nov 11 01:30 in Kolkata.
const NOW = new Date("2026-11-10T20:00:00.000Z");
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
let seq = 0;
const hex = (n) => String(n).padStart(24, "0");

function setup({ withNotifier = true, dispatch } = {}) {
  const Reservation = fakeCollection();
  const sent = [];
  const notifier = withNotifier
    ? { dispatch: dispatch || (async (event, ctx) => void sent.push([event, String(ctx.reservation._id)])) }
    : null;
  const make = () =>
    createSweeper({
      ReservationModel: Reservation,
      StayNightModel: fakeCollection(),
      AvailabilityBlockModel: fakeCollection(),
      ListingModel: { name: "ListingModel" },
      reservationService: { transition: async () => ({}) },
      deleteStaleDrafts: async () => ({ deleted: 0, photosRemoved: 0 }),
      destroyImage: async () => true,
      notifier,
    });
  const add = (over = {}) => {
    seq += 1;
    const doc = {
      _id: hex(seq),
      listing: hex(900),
      guest: hex(901),
      host: hex(902),
      status: "confirmed",
      checkIn: day("2026-11-11"),
      checkOut: day("2026-11-14"),
      nights: 3,
      guests: 2,
      listingSnapshot: { title: "Sea house", timezone: "America/New_York" },
      ...over,
    };
    Reservation.seed(doc);
    return doc._id;
  };
  const remindErrors = (summary) => summary.errors.filter((e) => e.step === "remind");
  return { Reservation, sent, add, make, remindErrors };
}

describe("check-in tomorrow", () => {
  test("a confirmed booking that starts tomorrow in its own zone is announced once", async () => {
    const { add, make, sent, Reservation, remindErrors } = setup();
    const id = add(); // Nov 11 in New York (today there is Nov 10)
    const summary = await make().runOnce({ now: NOW });
    expect(remindErrors(summary)).toEqual([]);
    expect(sent).toEqual([["reservation.checkin_tomorrow", id]]);
    expect(summary.reminded).toBe(1);
    expect(Reservation.rows.find((r) => r._id === id).reminders.checkIn).toEqual(NOW);
  });

  test("a later pass, or a second sweeper, does not send it again", async () => {
    const { add, make, sent } = setup();
    add();
    const a = make();
    const b = make();
    await a.runOnce({ now: NOW });
    await b.runOnce({ now: new Date(NOW.getTime() + 60 * 1000) });
    await a.runOnce({ now: new Date(NOW.getTime() + 120 * 1000) });
    expect(sent).toHaveLength(1);
  });

  test("two sweepers at the same moment: one sends, the other counts a skip", async () => {
    const { add, make, sent } = setup();
    add();
    const [x, y] = await Promise.all([make().runOnce({ now: NOW }), make().runOnce({ now: NOW })]);
    expect(sent).toHaveLength(1);
    expect(x.reminded + y.reminded).toBe(1);
    expect(x.skipped + y.skipped).toBe(1);
  });

  test("the day is judged in the listing's zone, not the server's", async () => {
    const { add, make, sent } = setup();
    // Same check-in date, Nov 11: tomorrow in New York, but already today in Kolkata.
    const ny = add({ listingSnapshot: { title: "NY", timezone: "America/New_York" } });
    add({ listingSnapshot: { title: "Kolkata", timezone: "Asia/Kolkata" } });
    // Nov 12 is tomorrow in Kolkata.
    const kol = add({ checkIn: day("2026-11-12"), checkOut: day("2026-11-14"), listingSnapshot: { title: "K2", timezone: "Asia/Kolkata" } });
    await make().runOnce({ now: NOW });
    expect(sent.map((s) => s[1]).sort()).toEqual([ny, kol].sort());
  });

  test("not today's, not the day after tomorrow's, not past ones", async () => {
    const { add, make, sent } = setup();
    add({ checkIn: day("2026-11-10"), checkOut: day("2026-11-12") });
    add({ checkIn: day("2026-11-12"), checkOut: day("2026-11-14") });
    add({ checkIn: day("2026-11-01"), checkOut: day("2026-11-03") });
    await make().runOnce({ now: NOW });
    expect(sent).toEqual([]);
  });

  test.each(["pending", "declined", "expired", "cancelled_by_guest", "cancelled_by_host", "completed"])(
    "a %s booking is not announced",
    async (status) => {
      const { add, make, sent } = setup();
      add({ status });
      await make().runOnce({ now: NOW });
      expect(sent).toEqual([]);
    },
  );

  test("one already announced is left alone", async () => {
    const { add, make, sent } = setup();
    add({ reminders: { checkIn: new Date("2026-11-10T00:00:00Z") } });
    await make().runOnce({ now: NOW });
    expect(sent).toEqual([]);
  });

  test("a booking with no zone uses the default zone (Asia/Kolkata)", async () => {
    const { add, make, sent } = setup();
    add({ checkIn: day("2026-11-12"), checkOut: day("2026-11-14"), listingSnapshot: { title: "x" } });
    await make().runOnce({ now: NOW });
    expect(sent).toHaveLength(1);
  });

  test("a failing dispatch is reported under the step name and the pass goes on", async () => {
    const { add, make, remindErrors } = setup({
      dispatch: async () => {
        throw new Error("boom");
      },
    });
    const id = add();
    const summary = await make().runOnce({ now: NOW });
    expect(remindErrors(summary)).toEqual([{ step: "remind", id, message: "boom" }]);
    expect(summary.reminded).toBe(0);
  });

  test("without a notifier the step does not run and the summary has no `reminded`", async () => {
    const { add, make, Reservation } = setup({ withNotifier: false });
    const id = add();
    const summary = await make().runOnce({ now: NOW });
    expect("reminded" in summary).toBe(false);
    expect(Reservation.rows.find((r) => r._id === id).reminders).toBeUndefined();
  });

  test("more than one page of bookings is all handled", async () => {
    const { add, sent, Reservation } = setup();
    for (let i = 0; i < 7; i += 1) add();
    const sweeper = createSweeper({
      ReservationModel: Reservation,
      StayNightModel: fakeCollection(),
      AvailabilityBlockModel: fakeCollection(),
      ListingModel: { name: "ListingModel" },
      reservationService: { transition: async () => ({}) },
      deleteStaleDrafts: async () => ({ deleted: 0 }),
      destroyImage: async () => true,
      notifier: { dispatch: async (event, ctx) => void sent.push([event, String(ctx.reservation._id)]) },
      options: { batchSize: 3 },
    });
    const summary = await sweeper.runOnce({ now: NOW });
    expect(summary.reminded).toBe(7);
    expect(new Set(sent.map((s) => s[1])).size).toBe(7);
  });
});
