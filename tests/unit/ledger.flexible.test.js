// P15-T04: search with "Available +-3 days": which listings have NO free stay of
// the same length starting within 3 days of the asked check-in.
const mongoose = require("mongoose");
const { createLedgerService } = require("../../src/services/ledger");

const id = () => new mongoose.Types.ObjectId();
const day = (text) => new Date(`${text}T00:00:00Z`);
const NOW = new Date("2026-10-17T10:00:00Z");
function build(rows) {
  const model = {
    find: jest.fn(() => ({ lean: () => Promise.resolve(rows) })),
  };
  return { model, service: createLedgerService({ model }) };
}
const nights = (listing, from, count) =>
  Array.from({ length: count }, (_, i) => ({
    listing,
    date: day(from) && new Date(day(from).getTime() + i * 86400000),
  }));
const FROM = day("2026-12-10");
const TO = day("2026-12-13"); // 3 nights: 10, 11, 12
const ask = (service, over = {}) =>
  service.unavailableListingIdsFlexible(FROM, TO, 3, {
    now: NOW,
    earliest: day("2026-10-17"),
    ...over,
  });

describe("unavailableListingIdsFlexible", () => {
  test("asks for the nights from 3 days before check-in to 3 days after check-out only", async () => {
    const { model, service } = build([]);
    await ask(service);
    expect(model.find.mock.calls[0][0]).toEqual({
      date: { $gte: day("2026-12-07"), $lt: day("2026-12-16") },
    });
  });

  test("a listing with the asked stay taken but a free shifted stay is NOT unavailable", async () => {
    const a = id();
    // nights 10, 11, 12 taken; nights 13, 14, 15 are free: a stay from 13 Dec (3 days later) fits
    const { service } = build(nights(a, "2026-12-10", 3));
    expect(await ask(service)).toEqual([]);
  });

  test("a listing taken on every shifted stay is unavailable, and returned once", async () => {
    const a = id();
    // taken 7..15: every 3-night stay starting 7..13 hits a taken night
    const { service } = build(nights(a, "2026-12-07", 9));
    expect(await ask(service)).toEqual([a]);
  });

  test("the edge: free only at a shift of 4 days is not enough; at 3 days it is", async () => {
    const a = id();
    const b = id();
    const rows = [
      ...nights(a, "2026-12-07", 10), // taken 7..16: first free start would be 17 (shift 7)
      // b: taken 8..15; a stay starting on the 7th would need nights 7, 8, 9: taken; start 16 is outside the window
      ...nights(b, "2026-12-08", 8),
    ];
    const { service } = build(rows);
    expect((await ask(service)).map(String).sort()).toEqual(
      [String(a), String(b)].sort(),
    );
    const c = id();
    // c: taken 10..15 -> free start on the 7th (nights 7, 8, 9): shift -3 is allowed
    const free = build(nights(c, "2026-12-10", 6));
    expect(await ask(free.service)).toEqual([]);
  });

  test("shifts that would start before the earliest allowed day (today) do not count", async () => {
    const a = id();
    // taken 10..15; the only free shifts are earlier ones (start 7, 8 or 9 would hit 10.. so 7 only fits)
    const { service } = build(nights(a, "2026-12-10", 6));
    expect(await ask(service, { earliest: day("2026-12-07") })).toEqual([]);
    expect(await ask(service, { earliest: day("2026-12-08") })).toEqual([a]);
  });

  test("an expired hold counts as free, a live hold as taken", async () => {
    const a = id();
    const live = new Date(NOW.getTime() + 3600000);
    const stale = new Date(NOW.getTime() - 3600000);
    const rows = nights(a, "2026-12-07", 9).map((r) => ({
      ...r,
      holdExpiresAt: stale,
    }));
    expect(await ask(build(rows).service)).toEqual([]);
    const liveRows = nights(a, "2026-12-07", 9).map((r) => ({
      ...r,
      holdExpiresAt: live,
    }));
    expect(await ask(build(liveRows).service)).toEqual([a]);
  });

  test("a listing with no rows at all is never returned (nothing is taken)", async () => {
    expect(await ask(build([]).service)).toEqual([]);
  });

  test("zero flexible days is the plain check on the asked stay", async () => {
    const a = id();
    const { service } = build(nights(a, "2026-12-11", 1));
    expect(
      await service.unavailableListingIdsFlexible(FROM, TO, 0, {
        now: NOW,
        earliest: FROM,
      }),
    ).toEqual([a]);
  });

  test("bad input is refused", async () => {
    const { service } = build([]);
    await expect(
      service.unavailableListingIdsFlexible(
        new Date("2026-12-10T10:00:00Z"),
        TO,
        3,
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      service.unavailableListingIdsFlexible(FROM, FROM, 3),
    ).rejects.toThrow(/after/);
    for (const bad of [-1, 15, 1.5, "3", undefined]) {
      await expect(
        service.unavailableListingIdsFlexible(FROM, TO, bad),
      ).rejects.toThrow(/flexDays/);
    }
  });
});
