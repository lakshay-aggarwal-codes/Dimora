// P07-T07: the sweeper against in-memory fakes, with an injected clock (time is
// moved, never waited for). Every test that touches reservations ends with the
// ledger/reservation invariant check. Parallel-instance behaviour on a real
// database is in tests/integration/sweeper.db.test.js.
const {
  createSweeper,
  startSweeper,
  shift,
  DEFAULTS,
} = require("../../src/services/sweeper");
const { createReservationService } = require("../../src/services/reservations");
const pricing = require("../../src/services/pricing");
const {
  SweeperReservationModel,
  StampedLedger,
  FakeNightModel,
  FakeBlockModel,
  fakeId,
} = require("../helpers/fakeSweeperDeps");
const { findViolations } = require("../helpers/invariants");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-10T06:00:00.000Z"); // 11:30 in Kolkata, 01:00 in New York
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const at = (ms) => shift(T0, ms);

function setup({ options, blocks = [], deleteStaleDrafts } = {}) {
  let clock = T0;
  const Reservation = new SweeperReservationModel();
  const ledger = new StampedLedger(() => clock);
  const Night = new FakeNightModel(ledger);
  const Block = new FakeBlockModel(blocks);
  const reservationService = createReservationService({
    ReservationModel: Reservation,
    ListingModel: { findById: async () => null },
    ledgerService: ledger,
    pricing,
    newId: fakeId,
  });
  const drafts =
    deleteStaleDrafts ||
    jest.fn(async () => ({ deleted: 0, photosRemoved: 0 }));
  const make = () =>
    createSweeper({
      ReservationModel: Reservation,
      StayNightModel: Night,
      AvailabilityBlockModel: Block,
      ListingModel: { name: "ListingModel" },
      reservationService,
      deleteStaleDrafts: drafts,
      destroyImage: async () => true,
      options,
    });
  const sweeper = make();

  /** A reservation plus the ledger rows its status calls for. */
  async function add({
    status = "pending",
    checkIn = "2026-12-01",
    checkOut = "2026-12-04",
    hold,
    tz = "Asia/Kolkata",
    nights = true,
    createdAt = T0,
  } = {}) {
    const _id = fakeId();
    const listing = fakeId();
    const doc = {
      _id,
      listing,
      guest: fakeId(),
      host: fakeId(),
      checkIn: day(checkIn),
      checkOut: day(checkOut),
      nights: Math.round((day(checkOut) - day(checkIn)) / DAY),
      guests: 2,
      status,
      listingSnapshot: { timezone: tz },
      statusHistory: [
        { from: null, to: status, at: createdAt, actor: "guest" },
      ],
      ...(status === "pending"
        ? { holdExpiresAt: hold || shift(createdAt, DAY) }
        : {}),
    };
    Reservation.docs.push(doc);
    if (nights) {
      for (
        let t = doc.checkIn.getTime();
        t < doc.checkOut.getTime();
        t += DAY
      ) {
        const date = new Date();
        date.setTime(t);
        ledger.rows.push({
          _id: fakeId(),
          listing,
          date,
          source: { kind: "reservation", id: _id },
          createdAt,
          ...(doc.holdExpiresAt ? { holdExpiresAt: doc.holdExpiresAt } : {}),
        });
      }
    }
    return doc;
  }

  function addRow({
    kind = "reservation",
    sourceId = fakeId(),
    createdAt = T0,
    date = "2026-12-01",
  } = {}) {
    const row = {
      _id: fakeId(),
      listing: fakeId(),
      date: day(date),
      source: { kind, id: sourceId },
      createdAt,
    };
    ledger.rows.push(row);
    return row;
  }

  return {
    Reservation,
    ledger,
    Night,
    Block,
    sweeper,
    drafts,
    make,
    add,
    addRow,
    setClock: (d) => {
      clock = d;
    },
    consistent: () =>
      expect(findViolations(Reservation.docs, ledger.rows)).toEqual([]),
    statusOf: (doc) => Reservation.docs.find((d) => d._id === doc._id).status,
  };
}

describe("expire: pending requests past their hold", () => {
  test("an unanswered request becomes expired and its nights are released", async () => {
    const ctx = setup();
    const old = await ctx.add({ hold: at(-1000) });
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.expired).toBe(1);
    expect(result.errors).toEqual([]);
    expect(ctx.statusOf(old)).toBe("expired");
    expect(ctx.ledger.rows).toHaveLength(0);
    const stored = ctx.Reservation.docs[0];
    expect(stored.holdExpiresAt).toBeUndefined();
    expect(stored.statusHistory.at(-1)).toEqual(
      expect.objectContaining({
        from: "pending",
        to: "expired",
        actor: "system",
      }),
    );
    ctx.consistent();
  });

  test("a request whose hold has not run out, and one exactly at the limit, are left alone", async () => {
    const ctx = setup();
    await ctx.add({ hold: at(1000) });
    await ctx.add({ hold: T0 });
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.expired).toBe(0);
    expect(ctx.ledger.rows).toHaveLength(6);
    ctx.consistent();
  });

  test("time travel: nothing at 23 h, expired at 25 h", async () => {
    const ctx = setup();
    const r = await ctx.add({ createdAt: T0 }); // hold = T0 + 24 h
    expect((await ctx.sweeper.runOnce({ now: at(23 * HOUR) })).expired).toBe(0);
    expect(ctx.statusOf(r)).toBe("pending");
    expect((await ctx.sweeper.runOnce({ now: at(25 * HOUR) })).expired).toBe(1);
    expect(ctx.statusOf(r)).toBe("expired");
    ctx.consistent();
  });

  test("only pending requests are touched: confirmed and cancelled ones with an old hold field stay", async () => {
    const ctx = setup();
    const confirmed = await ctx.add({
      status: "confirmed",
      checkIn: "2026-12-10",
      checkOut: "2026-12-12",
    });
    confirmed.holdExpiresAt = at(-HOUR); // stale leftover must not matter
    const declined = await ctx.add({ status: "declined", nights: false });
    await ctx.sweeper.runOnce({ now: T0 });
    expect(ctx.statusOf(confirmed)).toBe("confirmed");
    expect(ctx.statusOf(declined)).toBe("declined");
  });

  test("running again changes nothing (idempotent)", async () => {
    const ctx = setup();
    await ctx.add({ hold: at(-1000) });
    await ctx.sweeper.runOnce({ now: T0 });
    const again = await ctx.sweeper.runOnce({ now: at(1000) });
    expect(again).toEqual(
      expect.objectContaining({
        expired: 0,
        completed: 0,
        orphanNights: 0,
        skipped: 0,
        errors: [],
      }),
    );
    expect(ctx.Reservation.docs[0].statusHistory).toHaveLength(2);
  });

  test("two sweepers at once: one expires it, the other skips it (compare-and-set), no error", async () => {
    const ctx = setup();
    const r = await ctx.add({ hold: at(-1000) });
    const [a, b] = await Promise.all([
      ctx.make().runOnce({ now: T0 }),
      ctx.make().runOnce({ now: T0 }),
    ]);
    expect(a.expired + b.expired).toBe(1);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(ctx.statusOf(r)).toBe("expired");
    expect(
      ctx.Reservation.docs[0].statusHistory.filter((h) => h.to === "expired"),
    ).toHaveLength(1);
    ctx.consistent();
  });

  test("a guest who cancels in the same instant wins: the sweeper skips, nothing breaks", async () => {
    const ctx = setup();
    const r = await ctx.add({ hold: at(-1000) });
    const real = ctx.Reservation.findOneAndUpdate.bind(ctx.Reservation);
    ctx.Reservation.findOneAndUpdate = async (filter, update) => {
      // the guest's cancellation lands between the sweeper's read and its update
      Object.assign(ctx.Reservation.docs[0], { status: "cancelled_by_guest" });
      ctx.ledger.rows = [];
      return real(filter, update);
    };
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.skipped).toBe(1);
    expect(result.expired).toBe(0);
    expect(result.errors).toEqual([]);
    expect(ctx.statusOf(r)).toBe("cancelled_by_guest");
  });
});

describe("complete: confirmed stays whose check-out has passed", () => {
  test("completed on the check-out date, not before; the (past) nights are kept", async () => {
    const ctx = setup();
    const r = await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-07",
      checkOut: "2026-11-10",
    });
    // Kolkata date at T0 is 2026-11-10: the stay ended this morning
    expect((await ctx.sweeper.runOnce({ now: T0 })).completed).toBe(1);
    expect(ctx.statusOf(r)).toBe("completed");
    expect(ctx.ledger.rows).toHaveLength(3);
    ctx.consistent();

    const later = await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-08",
      checkOut: "2026-11-11",
    });
    expect((await ctx.sweeper.runOnce({ now: T0 })).completed).toBe(0);
    expect(ctx.statusOf(later)).toBe("confirmed");
    expect((await ctx.sweeper.runOnce({ now: at(DAY) })).completed).toBe(1);
    expect(ctx.statusOf(later)).toBe("completed");
    ctx.consistent();
  });

  test("uses the listing's own time zone, not the server's", async () => {
    const ctx = setup();
    // At T0 it is 2026-11-10 in Kolkata and still 2026-11-10 01:00 in New York;
    // move to 2026-11-10T20:00Z: Kolkata is already 11-11, New York is 11-10.
    const now = new Date("2026-11-10T20:00:00.000Z");
    const kolkata = await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-08",
      checkOut: "2026-11-11",
      tz: "Asia/Kolkata",
    });
    const newYork = await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-08",
      checkOut: "2026-11-11",
      tz: "America/New_York",
    });
    const result = await ctx.sweeper.runOnce({ now });
    expect(result.completed).toBe(1);
    expect(result.errors).toEqual([]);
    expect(ctx.statusOf(kolkata)).toBe("completed");
    expect(ctx.statusOf(newYork)).toBe("confirmed");
  });

  test("pending requests and cancelled stays are never completed", async () => {
    const ctx = setup();
    const pending = await ctx.add({
      status: "pending",
      checkIn: "2026-11-01",
      checkOut: "2026-11-03",
      hold: at(HOUR),
    });
    const cancelled = await ctx.add({
      status: "cancelled_by_guest",
      checkIn: "2026-11-01",
      checkOut: "2026-11-03",
      nights: false,
    });
    await ctx.sweeper.runOnce({ now: T0 });
    expect(ctx.statusOf(pending)).toBe("pending");
    expect(ctx.statusOf(cancelled)).toBe("cancelled_by_guest");
  });

  test("a second run does nothing", async () => {
    const ctx = setup();
    await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-07",
      checkOut: "2026-11-10",
    });
    await ctx.sweeper.runOnce({ now: T0 });
    const again = await ctx.sweeper.runOnce({ now: at(HOUR) });
    expect(again.completed).toBe(0);
    expect(ctx.Reservation.docs[0].statusHistory).toHaveLength(2);
  });
});

describe("orphans: ledger rows nobody owns", () => {
  const old = at(-HOUR);

  test("a row for a missing reservation is deleted once it is older than the grace period", async () => {
    const ctx = setup();
    ctx.addRow({ createdAt: old });
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.orphanNights).toBe(1);
    expect(ctx.ledger.rows).toHaveLength(0);
  });

  test("a young row is left alone: its owner may still be being written", async () => {
    const ctx = setup();
    ctx.addRow({ createdAt: at(-(DEFAULTS.orphanGraceMs - 1000)) });
    expect((await ctx.sweeper.runOnce({ now: T0 })).orphanNights).toBe(0);
    expect(ctx.ledger.rows).toHaveLength(1);
    // ...and goes once it has had its grace period
    expect(
      (await ctx.sweeper.runOnce({ now: at(DEFAULTS.orphanGraceMs) }))
        .orphanNights,
    ).toBe(1);
  });

  test("rows of declined, expired and cancelled reservations are deleted", async () => {
    const ctx = setup();
    for (const status of [
      "declined",
      "expired",
      "cancelled_by_guest",
      "cancelled_by_host",
    ]) {
      const r = await ctx.add({ status, nights: false });
      ctx.addRow({ sourceId: r._id, createdAt: old });
    }
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.orphanNights).toBe(4);
    expect(ctx.ledger.rows).toHaveLength(0);
    ctx.consistent();
  });

  test("rows of pending, confirmed and completed reservations are kept", async () => {
    const ctx = setup();
    await ctx.add({ status: "pending", hold: at(HOUR), createdAt: old });
    await ctx.add({
      status: "confirmed",
      checkIn: "2026-12-10",
      checkOut: "2026-12-12",
      createdAt: old,
    });
    await ctx.add({
      status: "completed",
      checkIn: "2026-11-01",
      checkOut: "2026-11-03",
      createdAt: old,
    });
    const before = ctx.ledger.rows.length;
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.orphanNights).toBe(0);
    expect(ctx.ledger.rows).toHaveLength(before);
    ctx.consistent();
  });

  test("a block row is kept while its block record exists and deleted when it does not", async () => {
    const kept = fakeId();
    const ctx = setup({ blocks: [kept] });
    ctx.addRow({
      kind: "block",
      sourceId: kept,
      createdAt: old,
      date: "2026-12-01",
    });
    ctx.addRow({
      kind: "block",
      sourceId: fakeId(),
      createdAt: old,
      date: "2026-12-02",
    });
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.orphanNights).toBe(1);
    expect(ctx.ledger.rows.map((r) => String(r.source.id))).toEqual([kept]);
  });

  test("re-running deletes nothing more", async () => {
    const ctx = setup();
    ctx.addRow({ createdAt: old });
    await ctx.sweeper.runOnce({ now: T0 });
    expect((await ctx.sweeper.runOnce({ now: at(1000) })).orphanNights).toBe(0);
  });

  test("a rolling window: a small scan size still reaches every row, then starts over", async () => {
    const ctx = setup({ options: { orphanScanRows: 2 } });
    for (let i = 0; i < 5; i += 1)
      ctx.addRow({ createdAt: old, date: `2026-12-0${i + 1}` });
    let removed = 0;
    let passes = 0;
    while (removed < 5 && passes < 10) {
      removed += (await ctx.sweeper.runOnce({ now: at(passes * 1000) }))
        .orphanNights;
      passes += 1;
    }
    expect(removed).toBe(5);
    expect(passes).toBe(3); // 2 + 2 + 1 rows
    expect(ctx.ledger.rows).toHaveLength(0);
  });

  test("pending requests past their hold are expired first, so their nights are not even orphans", async () => {
    const ctx = setup();
    await ctx.add({ hold: at(-HOUR), createdAt: at(-25 * HOUR) });
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.expired).toBe(1);
    expect(result.orphanNights).toBe(0);
    expect(ctx.ledger.rows).toHaveLength(0);
  });
});

describe("drafts: untouched for 90 days", () => {
  test("calls the draft clean-up with the clock, 90 days and the photo remover", async () => {
    const ctx = setup({
      deleteStaleDrafts: jest.fn(async () => ({
        deleted: 3,
        photosRemoved: 7,
      })),
    });
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.staleDrafts).toBe(3);
    expect(ctx.drafts).toHaveBeenCalledTimes(1);
    const [model, options] = ctx.drafts.mock.calls[0];
    expect(model).toEqual({ name: "ListingModel" });
    expect(options.now).toBe(T0);
    expect(options.days).toBe(90);
    expect(typeof options.destroy).toBe("function");
  });

  test("runs at most once an hour per instance, unless forced", async () => {
    const ctx = setup();
    await ctx.sweeper.runOnce({ now: T0 });
    await ctx.sweeper.runOnce({ now: at(30 * 60 * 1000) });
    expect(ctx.drafts).toHaveBeenCalledTimes(1);
    await ctx.sweeper.runOnce({ now: at(30 * 60 * 1000), drafts: true });
    expect(ctx.drafts).toHaveBeenCalledTimes(2);
    await ctx.sweeper.runOnce({ now: at(30 * 60 * 1000 + HOUR + 1000) });
    expect(ctx.drafts).toHaveBeenCalledTimes(3);
  });
});

describe("failures and limits", () => {
  test("a failing step is reported and the others still run", async () => {
    const ctx = setup({
      deleteStaleDrafts: jest.fn(async () => ({
        deleted: 2,
        photosRemoved: 0,
      })),
    });
    ctx.addRow({ createdAt: at(-HOUR) });
    ctx.Reservation.find = () => {
      throw new Error("database down");
    };
    const result = await ctx.sweeper.runOnce({ now: T0 });
    // the orphan step also needs to look reservations up, so it fails as well
    expect(result.errors.map((e) => e.step).sort()).toEqual([
      "complete",
      "expire",
      "orphans",
    ]);
    expect(result.errors.every((e) => e.message === "database down")).toBe(
      true,
    );
    expect(result.orphanNights).toBe(0);
    expect(ctx.ledger.rows).toHaveLength(1);
    expect(result.staleDrafts).toBe(2);
  });

  test("one reservation that cannot be moved does not stop the rest", async () => {
    const ctx = setup();
    const bad = await ctx.add({ hold: at(-1000), createdAt: at(-DAY) });
    const good = await ctx.add({ hold: at(-1000), createdAt: at(-DAY) });
    ctx.ledger.failRelease = true;
    const real = ctx.ledger.releaseNights.bind(ctx.ledger);
    ctx.ledger.releaseNights = async (id) => {
      if (id === bad._id) throw new Error("release failed");
      ctx.ledger.failRelease = false;
      return real(id);
    };
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.expired).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        step: "expire",
        id: bad._id,
        message: "release failed",
      }),
    ]);
    expect(ctx.statusOf(good)).toBe("expired");
    // The bad one is expired but its nights were not released. The orphan step
    // of the same pass finds them (expired owner, old rows) and removes them.
    expect(ctx.statusOf(bad)).toBe("expired");
    expect(result.orphanNights).toBe(3);
    expect(ctx.ledger.rows).toHaveLength(0);
    ctx.consistent();
  });

  test("a backlog is worked off in pages; a later run continues", async () => {
    const ctx = setup({ options: { batchSize: 2, maxBatches: 2 } });
    for (let i = 0; i < 5; i += 1)
      await ctx.add({ hold: at(-1000), createdAt: at(-DAY) });
    expect((await ctx.sweeper.runOnce({ now: T0 })).expired).toBe(4);
    expect((await ctx.sweeper.runOnce({ now: T0 })).expired).toBe(1);
    expect(ctx.Reservation.docs.every((d) => d.status === "expired")).toBe(
      true,
    );
    ctx.consistent();
  });

  test("a reservation that stays unmovable does not hide the ones behind it", async () => {
    const ctx = setup({ options: { batchSize: 1, maxBatches: 3 } });
    // The first confirmed stay is in a zone where it is not over yet; the next two are.
    const early = await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-08",
      checkOut: "2026-11-11",
      tz: "America/New_York",
    });
    await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-01",
      checkOut: "2026-11-03",
    });
    await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-02",
      checkOut: "2026-11-04",
    });
    const result = await ctx.sweeper.runOnce({
      now: new Date("2026-11-10T20:00:00.000Z"),
    });
    expect(result.completed).toBe(2);
    expect(ctx.statusOf(early)).toBe("confirmed");
  });

  test("an unknown time zone on a reservation is an error for that reservation only", async () => {
    const ctx = setup();
    const broken = await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-01",
      checkOut: "2026-11-03",
      tz: "Mars/Olympus",
    });
    await ctx.add({
      status: "confirmed",
      checkIn: "2026-11-01",
      checkOut: "2026-11-03",
    });
    const result = await ctx.sweeper.runOnce({ now: T0 });
    expect(result.completed).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ step: "complete", id: broken._id }),
    ]);
  });
});

describe("shift", () => {
  test("moves a date without touching the original", () => {
    const moved = shift(T0, 90 * 60 * 1000);
    expect(moved.toISOString()).toBe("2026-11-10T07:30:00.000Z");
    expect(T0.toISOString()).toBe("2026-11-10T06:00:00.000Z");
  });
});

describe("startSweeper", () => {
  function fakeTimers() {
    const timers = { fn: null, ms: null, cleared: false, unrefed: false };
    return {
      timers,
      setIntervalFn: (fn, ms) => {
        timers.fn = fn;
        timers.ms = ms;
        return { unref: () => (timers.unrefed = true) };
      },
      clearIntervalFn: () => (timers.cleared = true),
    };
  }
  const summary = (over = {}) => ({
    expired: 0,
    completed: 0,
    orphanNights: 0,
    staleDrafts: 0,
    skipped: 0,
    errors: [],
    ...over,
  });
  const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

  test("runs at once, then on every tick, every interval; the timer does not hold the process open", async () => {
    const { timers, setIntervalFn, clearIntervalFn } = fakeTimers();
    const runOnce = jest.fn(async () => summary());
    const handle = startSweeper({
      runOnce,
      intervalMs: 60000,
      logger: logger(),
      setIntervalFn,
      clearIntervalFn,
    });
    await new Promise((resolve) => setImmediate(resolve)); // the immediate pass finishes
    expect(timers.ms).toBe(60000);
    expect(timers.unrefed).toBe(true);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await timers.fn();
    expect(runOnce).toHaveBeenCalledTimes(2);
    handle.stop();
    expect(timers.cleared).toBe(true);
  });

  test("a tick that arrives while a pass is still running is skipped", async () => {
    const { timers, setIntervalFn } = fakeTimers();
    let release;
    const runOnce = jest.fn(
      () => new Promise((resolve) => (release = () => resolve(summary()))),
    );
    startSweeper({ runOnce, logger: logger(), setIntervalFn });
    timers.fn();
    timers.fn();
    expect(runOnce).toHaveBeenCalledTimes(1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    timers.fn(); // the earlier pass is done, so this one runs
    expect(runOnce).toHaveBeenCalledTimes(2);
    release();
    await new Promise((resolve) => setImmediate(resolve));
  });

  test("logs a line only when something was done, and logs step errors and crashes", async () => {
    const { setIntervalFn } = fakeTimers();
    const log = logger();
    const results = [
      summary(),
      summary({ expired: 2, skipped: 1 }),
      summary({ errors: [{ step: "expire", id: "x", message: "boom" }] }),
    ];
    const runOnce = jest.fn(async () => results.shift());
    const handle = startSweeper({ runOnce, logger: log, setIntervalFn });
    await new Promise((resolve) => setImmediate(resolve)); // the immediate pass
    expect(log.info).not.toHaveBeenCalled();
    await handle.tick();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ expired: 2, skipped: 1 }),
      "sweeper pass",
    );
    await handle.tick();
    expect(log.error).toHaveBeenCalledWith(
      { sweeper: { step: "expire", id: "x", message: "boom" } },
      "sweeper step failed",
    );

    runOnce.mockImplementationOnce(async () => {
      throw new Error("crash");
    });
    await handle.tick();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "sweeper pass crashed",
    );
    // and the loop is still alive
    runOnce.mockImplementationOnce(async () => summary({ completed: 1 }));
    await handle.tick();
    expect(log.info).toHaveBeenCalledTimes(2);
  });
});
