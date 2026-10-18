// P05-T02: which listings have a taken night in a stay (used by search).
const mongoose = require("mongoose");
const { createLedgerService } = require("../../src/services/ledger");

const id = () => new mongoose.Types.ObjectId();
const day = (text) => new Date(`${text}T00:00:00Z`);
function build(rows) {
  const model = {
    find: jest.fn(() => ({ lean: () => Promise.resolve(rows) })),
  };
  return { model, service: createLedgerService({ model }) };
}
const NOW = new Date("2026-10-17T10:00:00Z");

describe("unavailableListingIds", () => {
  test("asks for rows with a night in [from, to) only", async () => {
    const { model, service } = build([]);
    await service.unavailableListingIds(day("2026-12-24"), day("2026-12-27"), {
      now: NOW,
    });
    expect(model.find.mock.calls[0][0]).toEqual({
      date: { $gte: day("2026-12-24"), $lt: day("2026-12-27") },
    });
  });

  test("returns each listing once", async () => {
    const a = id();
    const b = id();
    const { service } = build([
      { listing: a, date: day("2026-12-24") },
      { listing: a, date: day("2026-12-25") },
      { listing: b, date: day("2026-12-25") },
    ]);
    const result = await service.unavailableListingIds(
      day("2026-12-24"),
      day("2026-12-27"),
      { now: NOW },
    );
    expect(result.map(String).sort()).toEqual([String(a), String(b)].sort());
  });

  test("a hold that has expired does not count; a live hold and a confirmed night do", async () => {
    const stale = id();
    const live = id();
    const confirmed = id();
    const { service } = build([
      { listing: stale, holdExpiresAt: new Date("2026-10-17T09:00:00Z") },
      { listing: live, holdExpiresAt: new Date("2026-10-17T11:00:00Z") },
      { listing: confirmed },
    ]);
    const result = await service.unavailableListingIds(
      day("2026-12-24"),
      day("2026-12-27"),
      { now: NOW },
    );
    expect(result.map(String).sort()).toEqual(
      [String(live), String(confirmed)].sort(),
    );
  });

  test("no rows, no listings", async () => {
    const { service } = build([]);
    expect(
      await service.unavailableListingIds(
        day("2026-12-24"),
        day("2026-12-27"),
        { now: NOW },
      ),
    ).toEqual([]);
  });

  test.each([
    [new Date("2026-12-24T10:00:00Z"), day("2026-12-27"), /date-only/],
    [day("2026-12-24"), "2026-12-27", /date-only/],
    [day("2026-12-27"), day("2026-12-24"), /after from/],
    [day("2026-12-24"), day("2026-12-24"), /after from/],
    [day("2026-01-01"), day("2028-01-01"), /at most/],
  ])("bad range %#", async (from, to, message) => {
    const { service } = build([]);
    await expect(
      service.unavailableListingIds(from, to, { now: NOW }),
    ).rejects.toThrow(message);
  });
});
