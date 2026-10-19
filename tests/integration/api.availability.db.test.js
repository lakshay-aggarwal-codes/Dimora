// P07-T04: the availability API against a real MongoDB and the real ledger.
// Skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createListing } = require("../helpers/factories");
const StayNight = require("../../src/models/stayNight");
const ledger = require("../../src/services/ledger");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const offset = (n) => addDays(todayIn(), n);
const text = (n) => formatDateOnly(offset(n));
const oid = () => new mongoose.Types.ObjectId();

describeDb("availability API (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await StayNight.init();
  });

  const get = (listing, qs) =>
    createAgent().get(`/api/listings/${listing._id}/availability?${qs}`);

  test("blocks and reservations are reported identically, other listings are not", async () => {
    const listing = await createListing();
    const other = await createListing();
    await ledger.reserveNights(listing._id, [offset(12), offset(13)], { kind: "block", id: oid() });
    await ledger.reserveNights(listing._id, [offset(20)], { kind: "reservation", id: oid() });
    await ledger.reserveNights(other._id, [offset(15)], { kind: "reservation", id: oid() });

    const res = await get(listing, `from=${text(10)}&to=${text(40)}`);
    expect(res.status).toBe(200);
    expect(res.body.unavailable).toEqual([text(12), text(13), text(20)]);
    expect(JSON.stringify(res.body)).not.toMatch(/reservation|block|source/i);
  });

  test("the check-out day is not an unavailable night; a live hold is, an expired one is not", async () => {
    const listing = await createListing();
    // a stay of 2 nights: check-in offset(12), check-out offset(14): night 14 is free
    await ledger.reserveNights(listing._id, [offset(12), offset(13)], { kind: "reservation", id: oid() });
    await ledger.reserveNights(listing._id, [offset(30)], { kind: "reservation", id: oid() }, offset(60));
    // an expired hold: insert directly (the service refuses a hold in the past)
    await StayNight.create({
      listing: listing._id,
      date: offset(31),
      source: { kind: "reservation", id: oid() },
      holdExpiresAt: new Date(Date.now() - 60 * 1000),
    });

    const res = await get(listing, `from=${text(10)}&to=${text(40)}`);
    expect(res.body.unavailable).toEqual([text(12), text(13), text(30)]);
  });

  test("a freed night disappears at once (no stale cache)", async () => {
    const listing = await createListing();
    const source = { kind: "block", id: oid() };
    await ledger.reserveNights(listing._id, [offset(12)], source);
    expect((await get(listing, `from=${text(10)}&to=${text(20)}`)).body.unavailable).toEqual([text(12)]);
    await ledger.releaseNights(source.id);
    expect((await get(listing, `from=${text(10)}&to=${text(20)}`)).body.unavailable).toEqual([]);
  });

  test("a draft listing answers 404 to a visitor", async () => {
    const listing = await createListing({ status: "draft" });
    const res = await get(listing, `from=${text(10)}&to=${text(20)}`);
    expect(res.status).toBe(404);
  });
});
