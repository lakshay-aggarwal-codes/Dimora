// P09-T04: the ledger helpers that change a booking's dates by the difference
// between the old and the new nights. In-memory model; the real unique index
// is exercised by tests/integration/modifications.db.test.js.
const { createLedgerService } = require("../../src/services/ledger");
const { FakeStayNight, fakeId } = require("../helpers/fakeStayNight");
const { parseDateOnly, addDays } = require("../../src/utils/dates");

const LISTING = fakeId();
const BASE = parseDateOnly("2099-06-10");
const night = (n) => addDays(BASE, n);
const days = (...ns) => ns.map(night);
const idGen = () => fakeId();

function setup() {
  const model = new FakeStayNight();
  const service = createLedgerService({ model, newId: idGen, isValidId: () => true });
  const dates = (sourceId) =>
    model.rows
      .filter((r) => String(r.source.id) === String(sourceId))
      .map((r) => r.date.getTime())
      .sort((a, b) => a - b);
  return { model, service, dates };
}

describe("releaseNightsOn", () => {
  test("frees only the given nights of that source", async () => {
    const { service, dates } = setup();
    const mine = fakeId();
    const other = fakeId();
    await service.reserveNights(LISTING, days(0, 1, 2), { kind: "reservation", id: mine });
    await service.reserveNights(LISTING, days(5), { kind: "reservation", id: other });
    await expect(service.releaseNightsOn(mine, days(1, 2, 5))).resolves.toEqual({ released: 2 });
    expect(dates(mine)).toEqual(days(0).map((d) => d.getTime()));
    expect(dates(other)).toEqual(days(5).map((d) => d.getTime())); // another source's night is never touched
  });

  test("safe to call twice; needs real nights", async () => {
    const { service } = setup();
    const id = fakeId();
    await service.reserveNights(LISTING, days(0), { kind: "reservation", id });
    await service.releaseNightsOn(id, days(0));
    await expect(service.releaseNightsOn(id, days(0))).resolves.toEqual({ released: 0 });
    await expect(service.releaseNightsOn(id, [])).rejects.toThrow(TypeError);
  });
});

describe("trimNights", () => {
  test("keeps exactly the given nights of the source and nothing else of it", async () => {
    const { service, dates } = setup();
    const mine = fakeId();
    const other = fakeId();
    await service.reserveNights(LISTING, days(0, 1, 2, 3), { kind: "reservation", id: mine });
    await service.reserveNights(LISTING, days(9), { kind: "reservation", id: other });
    await expect(service.trimNights(mine, days(2, 3))).resolves.toEqual({ released: 2 });
    expect(dates(mine)).toEqual(days(2, 3).map((d) => d.getTime()));
    expect(dates(other)).toHaveLength(1);
  });

  test("idempotent: running it again changes nothing", async () => {
    const { service, dates } = setup();
    const mine = fakeId();
    await service.reserveNights(LISTING, days(0, 1), { kind: "reservation", id: mine });
    await service.trimNights(mine, days(1));
    await expect(service.trimNights(mine, days(1))).resolves.toEqual({ released: 0 });
    expect(dates(mine)).toEqual(days(1).map((d) => d.getTime()));
  });
});

describe("extendHold", () => {
  test("moves the hold of held rows of that source only; confirmed rows stay without one", async () => {
    const { model, service } = setup();
    const NOW = new Date("2099-01-01T00:00:00Z");
    const soon = new Date("2099-01-02T00:00:00Z");
    const later = new Date("2099-01-03T00:00:00Z");
    const pending = fakeId();
    const confirmed = fakeId();
    await service.reserveNights(LISTING, days(0, 1), { kind: "reservation", id: pending }, soon, { now: NOW });
    await service.reserveNights(LISTING, days(5), { kind: "reservation", id: confirmed }, null, { now: NOW });
    await expect(service.extendHold(pending, later, { now: NOW })).resolves.toEqual({ extended: 2 });
    const rowsOf = (id) => model.rows.filter((r) => String(r.source.id) === String(id));
    expect(rowsOf(pending).every((r) => r.holdExpiresAt.getTime() === later.getTime())).toBe(true);
    expect(rowsOf(confirmed).every((r) => r.holdExpiresAt === undefined)).toBe(true);
  });

  test("a hold in the past, or none, is refused", async () => {
    const { service } = setup();
    const id = fakeId();
    const NOW = new Date("2099-01-01T00:00:00Z");
    await expect(service.extendHold(id, new Date("2098-01-01T00:00:00Z"), { now: NOW })).rejects.toThrow(TypeError);
    await expect(service.extendHold(id, null, { now: NOW })).rejects.toThrow(TypeError);
  });
});

describe("a date change in ledger terms", () => {
  test("hold the added nights first, then trim: a night is never free while the booking needs it, and a clash changes nothing", async () => {
    const { service, dates } = setup();
    const mine = fakeId();
    const rival = fakeId();
    await service.reserveNights(LISTING, days(0, 1, 2), { kind: "reservation", id: mine });
    await service.reserveNights(LISTING, days(4), { kind: "reservation", id: rival });

    // move 0..2 -> 2..4: night 4 belongs to somebody else
    await expect(service.reserveNights(LISTING, days(3, 4), { kind: "reservation", id: mine })).rejects.toThrow();
    expect(dates(mine)).toEqual(days(0, 1, 2).map((d) => d.getTime())); // untouched, even night 3 (rolled back)

    // move 0..2 -> 1..3: night 3 is free
    await service.reserveNights(LISTING, days(3), { kind: "reservation", id: mine });
    await service.trimNights(mine, days(1, 2, 3));
    expect(dates(mine)).toEqual(days(1, 2, 3).map((d) => d.getTime()));
    expect(dates(rival)).toHaveLength(1);
  });
});
