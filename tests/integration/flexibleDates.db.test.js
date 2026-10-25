// P15-T04 against a real MongoDB: the suggestions over the real night ledger
// and the flexible search query. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/flexibleDates.db.test.js
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const StayNight = require("../../src/models/stayNight");
const ledger = require("../../src/services/ledger");
const { suggestAlternatives } = require("../../src/services/flexibleDates");
const { getQuote } = require("../../src/services/quoteService");
const {
  addDays,
  eachNight,
  formatDateOnly,
  todayIn,
} = require("../../src/utils/dates");

const TODAY = todayIn();
const day = (n) => addDays(TODAY, n);

describeDb("flexible dates (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await StayNight.init();
  });

  async function setup() {
    const host = (await createUser()).user;
    const listing = await createListing({
      owner: host,
      minNights: 1,
      maxNights: 14,
      capacity: { guests: 4 },
    });
    return listing;
  }
  const take = (listing, from, n, hold) =>
    ledger.reserveNights(
      listing._id,
      eachNight(day(from), day(from + n)),
      { kind: "block", id: new mongoose.Types.ObjectId() },
      hold || null,
    );

  test("offers the nearest free stays; each can be booked by the real quote at that moment", async () => {
    const listing = await setup();
    await take(listing, 30, 3);
    const stay = { checkIn: day(30), checkOut: day(33), guests: 2 };
    const { windows } = await suggestAlternatives(listing, stay);
    expect(windows.map((w) => [w.in, w.shiftDays])).toEqual([
      [formatDateOnly(day(27)), -3],
      [formatDateOnly(day(33)), 3],
      [formatDateOnly(day(24)), -6],
    ]);
    for (const w of windows) {
      const quote = await getQuote(listing, {
        in: w.in,
        out: w.out,
        guests: "2",
      });
      expect(quote.bookable).toBe(true);
      expect(quote.quote.totalMinor).toBe(w.quote.totalMinor);
    }
  });

  test("a stay that was free is not offered the moment it is taken", async () => {
    const listing = await setup();
    await take(listing, 30, 3);
    const stay = { checkIn: day(30), checkOut: day(33), guests: 2 };
    await take(listing, 27, 3); // the nearest one goes
    const { windows } = await suggestAlternatives(listing, stay);
    expect(windows.map((w) => w.in)).not.toContain(formatDateOnly(day(27)));
    expect(windows[0].in).toBe(formatDateOnly(day(33)));
  });

  test("an expired hold counts as free, a live hold does not", async () => {
    const listing = await setup();
    await take(listing, 30, 3);
    await take(listing, 27, 3, new Date(Date.now() - 3600000)); // already expired
    const stay = { checkIn: day(30), checkOut: day(33), guests: 2 };
    expect((await suggestAlternatives(listing, stay)).windows[0].in).toBe(
      formatDateOnly(day(27)),
    );
  });

  test("a fully blocked month: no windows", async () => {
    const listing = await setup();
    await take(listing, 5, 70);
    const stay = { checkIn: day(30), checkOut: day(33), guests: 2 };
    expect(await suggestAlternatives(listing, stay)).toEqual({
      radiusDays: 14,
      windows: [],
    });
  });

  test("the search: a listing busy on the asked dates but free 3 days later stays; one busy all around goes", async () => {
    const near = await setup();
    const busy = await setup();
    await take(near, 30, 3); // free again from day 33: a shifted stay fits
    await take(busy, 26, 10); // taken 26..35: nothing within 3 days is free
    const from = day(30);
    const to = day(33);
    const strict = (await ledger.unavailableListingIds(from, to)).map(String);
    expect(strict.sort()).toEqual([String(near._id), String(busy._id)].sort());
    const flexible = (
      await ledger.unavailableListingIdsFlexible(from, to, 3, {
        earliest: TODAY,
      })
    ).map(String);
    expect(flexible).toEqual([String(busy._id)]);
  });

  test("the search never counts a shift into the past", async () => {
    const listing = await setup();
    await take(listing, 2, 3); // taken 2..4; the free window would start on day -1, in the past
    const flexible = await ledger.unavailableListingIdsFlexible(
      day(2),
      day(5),
      3,
      { earliest: TODAY },
    );
    expect(flexible.map(String)).toEqual([]); // day 5 onwards is free: a start 3 days later fits
    const blocked = await setup();
    await take(blocked, 2, 8);
    expect(
      (
        await ledger.unavailableListingIdsFlexible(day(2), day(5), 3, {
          earliest: TODAY,
        })
      ).map(String),
    ).toEqual([String(blocked._id)]);
  });
});
