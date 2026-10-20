// P07-T03 additions to the ledger service: reading a range of nights for the
// calendar and releasing only host-blocked nights. Logic against the in-memory
// fake model; the real index and driver are covered by
// tests/integration/availability.db.test.js.
const { createLedgerService } = require("../../src/services/ledger");
const { parseDateOnly, addDays } = require("../../src/utils/dates");
const { FakeStayNight, fakeId } = require("../helpers/fakeStayNight");

const d = (s) => parseDateOnly(s);
const range = (start, count) =>
  Array.from({ length: count }, (_, i) => addDays(d(start), i));
const isValidId = (v) => typeof v === "string" && /^[0-9a-f]{24}$/.test(v);
const NOW = new Date("2026-10-20T06:00:00Z");

let model;
let ledger;
beforeEach(() => {
  model = new FakeStayNight();
  ledger = createLedgerService({ model, newId: fakeId, isValidId });
});

const reservation = () => ({ kind: "reservation", id: fakeId() });
const block = () => ({ kind: "block", id: fakeId() });

describe("nightsInRange", () => {
  test("lists the occupied nights of one listing, oldest first, with who owns them", async () => {
    const listing = fakeId();
    const stay = reservation();
    const hold = block();
    await ledger.reserveNights(listing, range("2026-11-10", 2), stay);
    await ledger.reserveNights(listing, range("2026-11-03", 2), hold);
    await ledger.reserveNights(fakeId(), range("2026-11-03", 5), block()); // other listing

    const rows = await ledger.nightsInRange(
      listing,
      d("2026-11-01"),
      d("2026-12-01"),
      { now: NOW },
    );
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      "2026-11-03",
      "2026-11-04",
      "2026-11-10",
      "2026-11-11",
    ]);
    expect(rows[0].source).toEqual(hold);
    expect(rows[2].source).toEqual(stay);
    expect(rows[0].holdExpiresAt).toBeNull();
  });

  test("the range is [from, to): the 'to' day is not included", async () => {
    const listing = fakeId();
    await ledger.reserveNights(listing, range("2026-11-05", 3), block());
    const rows = await ledger.nightsInRange(
      listing,
      d("2026-11-05"),
      d("2026-11-07"),
      { now: NOW },
    );
    expect(rows).toHaveLength(2);
  });

  test("a live hold is listed (with its expiry), an expired hold is not", async () => {
    const listing = fakeId();
    const live = new Date("2026-10-21T06:00:00Z");
    await ledger.reserveNights(listing, range("2026-11-05", 1), reservation(), live, {
      now: NOW,
    });
    await ledger.reserveNights(
      listing,
      range("2026-11-08", 1),
      reservation(),
      new Date("2026-10-20T07:00:00Z"),
      { now: NOW },
    );
    const later = new Date("2026-10-20T08:00:00Z"); // second hold has run out
    const rows = await ledger.nightsInRange(
      listing,
      d("2026-11-01"),
      d("2026-12-01"),
      { now: later },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].holdExpiresAt.getTime()).toBe(live.getTime());
  });

  test("the result carries no more than date, source and hold (no guest data)", async () => {
    const listing = fakeId();
    await ledger.reserveNights(listing, range("2026-11-05", 1), reservation());
    const [row] = await ledger.nightsInRange(
      listing,
      d("2026-11-01"),
      d("2026-12-01"),
      { now: NOW },
    );
    expect(Object.keys(row).sort()).toEqual(["date", "holdExpiresAt", "source"]);
    expect(Object.keys(row.source).sort()).toEqual(["id", "kind"]);
  });

  test("bad arguments are programming errors", async () => {
    const listing = fakeId();
    await expect(
      ledger.nightsInRange(listing, d("2026-11-05"), d("2026-11-05")),
    ).rejects.toThrow(TypeError);
    await expect(
      ledger.nightsInRange(listing, d("2026-11-05"), d("2028-01-01")),
    ).rejects.toThrow(TypeError);
    await expect(
      ledger.nightsInRange(listing, new Date("2026-11-05T01:00:00Z"), d("2026-11-09")),
    ).rejects.toThrow(TypeError);
    await expect(
      ledger.nightsInRange("nope", d("2026-11-05"), d("2026-11-09")),
    ).rejects.toThrow(TypeError);
  });
});

describe("releaseBlockedNights", () => {
  test("frees blocked nights in the range and never a reserved night", async () => {
    const listing = fakeId();
    const mine = block();
    const stay = reservation();
    await ledger.reserveNights(listing, range("2026-11-05", 3), mine);
    await ledger.reserveNights(listing, range("2026-11-08", 2), stay);

    const result = await ledger.releaseBlockedNights(
      listing,
      d("2026-11-01"),
      d("2026-12-01"),
    );
    expect(result.released).toBe(3);
    expect(model.rows).toHaveLength(2);
    expect(model.rows.every((r) => r.source.id === stay.id)).toBe(true);
  });

  test("a range that only covers reserved nights releases nothing", async () => {
    const listing = fakeId();
    await ledger.reserveNights(listing, range("2026-11-05", 3), reservation());
    const result = await ledger.releaseBlockedNights(
      listing,
      d("2026-11-05"),
      d("2026-11-08"),
    );
    expect(result).toEqual({ released: 0, emptiedSourceIds: [] });
    expect(model.rows).toHaveLength(3);
  });

  test("reports blocks with no night left, not blocks that keep some", async () => {
    const listing = fakeId();
    const whole = block();
    const partly = block();
    await ledger.reserveNights(listing, range("2026-11-05", 2), whole);
    await ledger.reserveNights(listing, range("2026-11-10", 4), partly);

    const result = await ledger.releaseBlockedNights(
      listing,
      d("2026-11-05"),
      d("2026-11-12"), // all of `whole`, the first two nights of `partly`
    );
    expect(result.released).toBe(4);
    expect(result.emptiedSourceIds).toEqual([whole.id]);
    expect(model.rows).toHaveLength(2);
    expect(model.rows.every((r) => r.source.id === partly.id)).toBe(true);
  });

  test("another listing's blocks are never touched", async () => {
    const listing = fakeId();
    const other = fakeId();
    await ledger.reserveNights(other, range("2026-11-05", 3), block());
    const result = await ledger.releaseBlockedNights(
      listing,
      d("2026-11-01"),
      d("2026-12-01"),
    );
    expect(result.released).toBe(0);
    expect(model.rows).toHaveLength(3);
  });

  test("doing it twice is harmless", async () => {
    const listing = fakeId();
    await ledger.reserveNights(listing, range("2026-11-05", 2), block());
    const first = await ledger.releaseBlockedNights(listing, d("2026-11-05"), d("2026-11-07"));
    const second = await ledger.releaseBlockedNights(listing, d("2026-11-05"), d("2026-11-07"));
    expect(first.released).toBe(2);
    expect(second).toEqual({ released: 0, emptiedSourceIds: [] });
  });

  test("a bad range is a programming error", async () => {
    await expect(
      ledger.releaseBlockedNights(fakeId(), d("2026-11-07"), d("2026-11-05")),
    ).rejects.toThrow(TypeError);
  });
});
