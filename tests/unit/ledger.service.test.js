// Ledger service logic against an in-memory fake model (no mongod).
// Real-database behaviour (unique index, driver errors, true concurrency) is in
// tests/integration/ledger.db.test.js.
const { createLedgerService } = require("../../src/services/ledger");
const { ConflictError } = require("../../src/utils/errors");
const { parseDateOnly, addDays } = require("../../src/utils/dates");
const { FakeStayNight, fakeId } = require("../helpers/fakeStayNight");

const d = (s) => parseDateOnly(s);
const range = (start, count) =>
  Array.from({ length: count }, (_, i) => addDays(d(start), i));
const time = (date) => date.getTime();

let model;
let ledger;
const isValidId = (v) => typeof v === "string" && /^[0-9a-f]{24}$/.test(v);

beforeEach(() => {
  model = new FakeStayNight();
  ledger = createLedgerService({ model, newId: fakeId, isValidId });
});

const reservation = () => ({ kind: "reservation", id: fakeId() });
const block = () => ({ kind: "block", id: fakeId() });
const rowsFor = (sourceId) =>
  model.rows.filter((r) => r.source.id === sourceId);

describe("reserveNights", () => {
  test("holds every night, inserted in ascending order", async () => {
    const listing = fakeId();
    const source = reservation();
    const nights = range("2026-11-01", 3).reverse(); // given out of order
    const result = await ledger.reserveNights(listing, nights, source);

    expect(result.reserved).toBe(3);
    expect(model.rows.map((r) => time(r.date))).toEqual(
      range("2026-11-01", 3).map(time),
    );
    expect(model.rows[0].source).toEqual(source);
    expect(model.rows[0].holdExpiresAt).toBe(undefined);
  });

  test("stores holdExpiresAt for a pending request", async () => {
    const hold = new Date("2026-11-01T12:00:00Z");
    await ledger.reserveNights(
      fakeId(),
      range("2026-11-05", 2),
      reservation(),
      hold,
      { now: new Date("2026-11-01T10:00:00Z") },
    );
    expect(model.rows.every((r) => time(r.holdExpiresAt) === time(hold))).toBe(
      true,
    );
  });

  test("rejects bad input as programming errors", async () => {
    const listing = fakeId();
    const nights = range("2026-11-01", 2);
    const now = new Date("2026-11-01T10:00:00Z");
    const bad = [
      [listing, [], reservation()],
      [listing, "2026-11-01", reservation()],
      [listing, [new Date("2026-11-01T05:00:00Z")], reservation()],
      [listing, [nights[0], nights[0]], reservation()],
      [listing, nights, { kind: "nope", id: fakeId() }],
      [listing, nights, { kind: "block", id: "not-an-id" }],
      [listing, nights, null],
      ["nope", nights, reservation()],
      [listing, range("2026-01-01", 367), reservation()],
    ];
    for (const [l, n, s] of bad) {
      await expect(ledger.reserveNights(l, n, s, null, { now })).rejects.toThrow(
        TypeError,
      );
    }
    await expect(
      ledger.reserveNights(listing, nights, reservation(), new Date(NaN), {
        now,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      ledger.reserveNights(listing, nights, reservation(), new Date(now), {
        now,
      }),
    ).rejects.toThrow(/in the future/);
    expect(model.rows).toHaveLength(0);
  });

  test("a held night is a ConflictError naming the nights; nothing is left behind", async () => {
    const listing = fakeId();
    const blocker = block();
    await ledger.reserveNights(listing, [d("2026-11-04")], blocker);

    let error;
    try {
      await ledger.reserveNights(listing, range("2026-11-02", 5), reservation());
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("nights_unavailable");
    expect(error.conflictingDates.map(time)).toEqual([time(d("2026-11-04"))]);
    expect(error.message).toMatch(/2026-11-04/);
    // Nights 2 and 3 were inserted before the collision and must be rolled back.
    expect(model.rows).toHaveLength(1);
    expect(rowsFor(blocker.id)).toHaveLength(1);
  });

  test("a non-duplicate failure also rolls back partial inserts", async () => {
    model.failInsertAfter = 2;
    await expect(
      ledger.reserveNights(fakeId(), range("2026-11-01", 5), reservation()),
    ).rejects.toThrow(/simulated database failure/);
    expect(model.rows).toHaveLength(0);
  });

  test("if rolling back fails, the error says so and keeps the cause", async () => {
    model.failInsertAfter = 1;
    model.deleteManyFailure = new Error("connection lost");
    let error;
    try {
      await ledger.reserveNights(fakeId(), range("2026-11-01", 3), reservation());
    } catch (err) {
      error = err;
    }
    expect(error.message).toMatch(/compensation failed/);
    expect(error.cause.message).toMatch(/simulated database failure/);
    expect(error.cleanupError.message).toBe("connection lost");
  });

  test("the same nights on another listing are independent", async () => {
    const nights = range("2026-11-01", 3);
    await ledger.reserveNights(fakeId(), nights, reservation());
    await ledger.reserveNights(fakeId(), nights, reservation());
    expect(model.rows).toHaveLength(6);
  });

  test("touching stays do not conflict: check-out day is free", async () => {
    const listing = fakeId();
    await ledger.reserveNights(listing, range("2026-11-01", 3), reservation());
    await ledger.reserveNights(listing, range("2026-11-04", 2), reservation());
    expect(model.rows).toHaveLength(5);
  });

  test("retrying the same source never deletes the rows it already holds", async () => {
    const listing = fakeId();
    const source = reservation();
    const nights = range("2026-11-01", 3);
    await ledger.reserveNights(listing, nights, source);
    await expect(
      ledger.reserveNights(listing, nights, source),
    ).rejects.toThrow(ConflictError);
    expect(rowsFor(source.id)).toHaveLength(3);
  });

  test("50 parallel requests for the same nights: exactly one wins", async () => {
    const listing = fakeId();
    const nights = range("2026-12-24", 3);
    const sources = Array.from({ length: 50 }, reservation);
    const results = await Promise.allSettled(
      sources.map((s) => ledger.reserveNights(listing, nights, s)),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(49);
    expect(lost.every((r) => r.reason instanceof ConflictError)).toBe(true);
    expect(model.rows).toHaveLength(3);
    const winner = sources[results.findIndex((r) => r.status === "fulfilled")];
    expect(rowsFor(winner.id)).toHaveLength(3);
  });

  test("overlapping partial ranges: never both, each holder has all its nights, losers hold none", async () => {
    for (let round = 0; round < 30; round += 1) {
      const listing = fakeId();
      const a = reservation();
      const b = reservation();
      const [ra, rb] = await Promise.allSettled([
        ledger.reserveNights(listing, range("2026-12-01", 5), a), // 1..5
        ledger.reserveNights(listing, range("2026-12-04", 5), b), // 4..8
      ]);
      const wins = [ra, rb].filter((r) => r.status === "fulfilled").length;
      expect(wins).toBe(1); // overlapping: at least one wins, never both
      expect(rowsFor(a.id)).toHaveLength(ra.status === "fulfilled" ? 5 : 0);
      expect(rowsFor(b.id)).toHaveLength(rb.status === "fulfilled" ? 5 : 0);
    }
  });

  test("many random overlapping ranges: all-or-nothing and no night owned twice", async () => {
    let seed = 7;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const listing = fakeId();
    const attempts = Array.from({ length: 40 }, () => ({
      source: reservation(),
      start: rand(30),
      length: 1 + rand(6),
    }));
    const results = await Promise.allSettled(
      attempts.map(({ source, start, length }) =>
        ledger.reserveNights(
          listing,
          range("2027-01-01", 40).slice(start, start + length),
          source,
        ),
      ),
    );
    const owned = new Set();
    results.forEach((result, i) => {
      const held = rowsFor(attempts[i].source.id);
      if (result.status === "fulfilled") {
        expect(held).toHaveLength(attempts[i].length);
      } else {
        expect(held).toHaveLength(0);
      }
      for (const row of held) {
        expect(owned.has(time(row.date))).toBe(false);
        owned.add(time(row.date));
      }
    });
    expect(owned.size).toBe(model.rows.length);
  });

  describe("expired holds", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const past = new Date("2026-11-10T11:00:00Z");

    async function seedHold(listing, nights, holdExpiresAt) {
      const source = reservation();
      for (const date of nights) {
        model.rows.push({ _id: fakeId(), listing, date, source, holdExpiresAt });
      }
      return source;
    }

    test("an expired hold is taken over; only the nights asked for are touched", async () => {
      const listing = fakeId();
      const stale = await seedHold(listing, range("2026-12-01", 3), past);
      const taker = reservation();

      const result = await ledger.reserveNights(
        listing,
        range("2026-12-02", 3), // 2,3 are stale, 4 is free
        taker,
        null,
        { now },
      );
      expect(result.reserved).toBe(3);
      expect(rowsFor(taker.id)).toHaveLength(3);
      expect(rowsFor(stale.id).map((r) => time(r.date))).toEqual([
        time(d("2026-12-01")),
      ]);
    });

    test("a hold that has not expired still blocks", async () => {
      const listing = fakeId();
      await seedHold(listing, range("2026-12-01", 2), new Date("2026-11-10T13:00:00Z"));
      await expect(
        ledger.reserveNights(listing, range("2026-12-01", 2), reservation(), null, {
          now,
        }),
      ).rejects.toThrow(ConflictError);
      expect(model.rows).toHaveLength(2);
    });

    test("a confirmed reservation (no hold) is never taken over", async () => {
      const listing = fakeId();
      const confirmed = reservation();
      await ledger.reserveNights(listing, range("2026-12-01", 2), confirmed);
      await expect(
        ledger.reserveNights(listing, range("2026-12-01", 2), reservation(), null, {
          now: new Date("2030-01-01T00:00:00Z"),
        }),
      ).rejects.toThrow(ConflictError);
      expect(rowsFor(confirmed.id)).toHaveLength(2);
    });

    test("20 parallel takers of the same expired hold: exactly one wins", async () => {
      const listing = fakeId();
      await seedHold(listing, range("2026-12-01", 3), past);
      const sources = Array.from({ length: 20 }, reservation);
      const results = await Promise.allSettled(
        sources.map((s) =>
          ledger.reserveNights(listing, range("2026-12-01", 3), s, null, { now }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(model.rows).toHaveLength(3);
      expect(new Set(model.rows.map((r) => r.source.id)).size).toBe(1);
    });
  });
});

describe("releaseNights", () => {
  test("frees only that source's nights and is idempotent", async () => {
    const listing = fakeId();
    const a = reservation();
    const b = block();
    await ledger.reserveNights(listing, range("2026-11-01", 3), a);
    await ledger.reserveNights(listing, range("2026-11-10", 2), b);

    expect(await ledger.releaseNights(a.id)).toEqual({ released: 3 });
    expect(await ledger.releaseNights(a.id)).toEqual({ released: 0 });
    expect(await ledger.releaseNights(fakeId())).toEqual({ released: 0 });
    expect(rowsFor(b.id)).toHaveLength(2);

    // Freed nights can be booked again.
    await ledger.reserveNights(listing, range("2026-11-01", 3), reservation());
    expect(model.rows).toHaveLength(5);
  });

  test("rejects a malformed id", async () => {
    await expect(ledger.releaseNights("nope")).rejects.toThrow(TypeError);
  });
});

describe("availableRanges", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const view = (ranges) =>
    ranges.map((r) => [
      r.from.toISOString().slice(0, 10),
      r.to.toISOString().slice(0, 10),
      r.nights,
    ]);

  test("an empty calendar is one free range", async () => {
    const ranges = await ledger.availableRanges(
      fakeId(),
      d("2026-12-01"),
      d("2026-12-08"),
      { now },
    );
    expect(view(ranges)).toEqual([["2026-12-01", "2026-12-08", 7]]);
  });

  test("occupied nights split the range; `to` is exclusive", async () => {
    const listing = fakeId();
    await ledger.reserveNights(listing, [d("2026-12-03")], reservation());
    await ledger.reserveNights(listing, range("2026-12-06", 2), block());
    const ranges = await ledger.availableRanges(
      listing,
      d("2026-12-01"),
      d("2026-12-10"),
      { now },
    );
    expect(view(ranges)).toEqual([
      ["2026-12-01", "2026-12-03", 2],
      ["2026-12-04", "2026-12-06", 2],
      ["2026-12-08", "2026-12-10", 2],
    ]);
  });

  test("a fully booked window has no ranges; other listings are ignored", async () => {
    const listing = fakeId();
    await ledger.reserveNights(listing, range("2026-12-01", 3), reservation());
    await ledger.reserveNights(fakeId(), range("2026-12-10", 3), reservation());
    expect(
      await ledger.availableRanges(listing, d("2026-12-01"), d("2026-12-04"), {
        now,
      }),
    ).toEqual([]);
    expect(
      view(
        await ledger.availableRanges(listing, d("2026-12-10"), d("2026-12-13"), {
          now,
        }),
      ),
    ).toEqual([["2026-12-10", "2026-12-13", 3]]);
  });

  test("nights outside the window are ignored; an expired hold counts as free", async () => {
    const listing = fakeId();
    await ledger.reserveNights(listing, [d("2026-11-30")], reservation());
    await ledger.reserveNights(listing, [d("2026-12-10")], reservation());
    model.rows.push({
      _id: fakeId(),
      listing,
      date: d("2026-12-02"),
      source: reservation(),
      holdExpiresAt: new Date("2026-11-10T11:00:00Z"),
    });
    model.rows.push({
      _id: fakeId(),
      listing,
      date: d("2026-12-04"),
      source: reservation(),
      holdExpiresAt: new Date("2026-11-10T13:00:00Z"),
    });
    const ranges = await ledger.availableRanges(
      listing,
      d("2026-12-01"),
      d("2026-12-10"),
      { now },
    );
    expect(view(ranges)).toEqual([
      ["2026-12-01", "2026-12-04", 3],
      ["2026-12-05", "2026-12-10", 5],
    ]);
  });

  test("validates the window", async () => {
    const listing = fakeId();
    const from = d("2026-12-01");
    await expect(ledger.availableRanges(listing, from, from)).rejects.toThrow(
      TypeError,
    );
    await expect(
      ledger.availableRanges(listing, d("2026-12-05"), from),
    ).rejects.toThrow(TypeError);
    await expect(
      ledger.availableRanges(listing, from, addDays(from, 401)),
    ).rejects.toThrow(/at most 400/);
    await expect(
      ledger.availableRanges(listing, new Date("2026-12-01T03:00:00Z"), d("2026-12-05")),
    ).rejects.toThrow(TypeError);
    expect(
      await ledger.availableRanges(listing, from, addDays(from, 400)),
    ).toHaveLength(1);
  });
});
