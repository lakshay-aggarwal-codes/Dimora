// P18-T02: the two "all listings, one date range" ledger queries ask only for
// fields of the date index and leave _id out, so they are answered from the
// index alone. The registry in src/services/queryPlans.js declares the same
// projections; this keeps the service and the registry together.
const mongoose = require("mongoose");
const { createLedgerService } = require("../../src/services/ledger");
const { hotQueries } = require("../../src/services/queryPlans");

const day = (text) => new Date(`${text}T00:00:00Z`);
const NOW = new Date("2026-10-17T10:00:00Z");

function build(rows = []) {
  const model = {
    find: jest.fn(() => ({ lean: () => Promise.resolve(rows) })),
  };
  return { model, service: createLedgerService({ model }) };
}
const declared = (id) => hotQueries().find((q) => q.id === id);

test("unavailableListingIds: filter and projection are the declared ones", async () => {
  const { model, service } = build([
    { listing: new mongoose.Types.ObjectId() },
  ]);
  await service.unavailableListingIds(day("2026-12-10"), day("2026-12-13"), {
    now: NOW,
  });
  const [filter, projection] = model.find.mock.calls[0];
  expect(Object.keys(filter)).toEqual(["date"]);
  expect(projection).toEqual(
    declared("availability.all_listings_range").project,
  );
  expect(projection._id).toBe(0);
});

test("unavailableListingIdsFlexible: filter and projection are the declared ones", async () => {
  const { model, service } = build([]);
  await service.unavailableListingIdsFlexible(
    day("2026-12-10"),
    day("2026-12-13"),
    3,
    { now: NOW, earliest: day("2026-10-17") },
  );
  const [filter, projection] = model.find.mock.calls[0];
  expect(Object.keys(filter)).toEqual(["date"]);
  expect(projection).toEqual(declared("availability.flexible_range").project);
  expect(projection._id).toBe(0);
});

test("without _id the answers still come out right (the code never reads _id)", async () => {
  const a = new mongoose.Types.ObjectId();
  const rows = [
    { listing: a },
    { listing: a, holdExpiresAt: new Date(NOW.getTime() + 3600000) },
    {
      listing: new mongoose.Types.ObjectId(),
      holdExpiresAt: new Date(NOW.getTime() - 3600000),
    },
  ];
  const { service } = build(rows);
  expect(
    (
      await service.unavailableListingIds(
        day("2026-12-10"),
        day("2026-12-13"),
        { now: NOW },
      )
    ).map(String),
  ).toEqual([String(a)]);
});
