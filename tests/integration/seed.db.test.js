// P01-T06: scripts/seed.js runSeed() against a real database
// (see tests/helpers/db.js). Idempotent, --reset, and only the demo host's
// listings are ever touched.
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing, createReview } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const User = require("../../src/models/user");
const { runSeed, DEMO_HOST } = require("../../scripts/seed");

describeDb("seed script", () => {
  useTestDb();

  test("creates the demo host and 29 valid listings, all with geometry", async () => {
    const summary = await runSeed();
    expect(summary.total).toBe(29);
    expect(summary.created).toBe(29);
    expect(summary.generatedPassword).toEqual(expect.any(String));

    const host = await User.findOne({ username: DEMO_HOST.username });
    expect(host).not.toBeNull();

    const listings = await Listing.find({});
    expect(listings).toHaveLength(29);
    for (const listing of listings) {
      expect(String(listing.owner)).toBe(String(host._id));
      expect(listing.geometry.type).toBe("Point");
      expect(listing.geometry.coordinates).toHaveLength(2);
      expect(listing.validateSync()).toBeUndefined();
    }
  });

  test("running it twice does not duplicate anything", async () => {
    await runSeed();
    const second = await runSeed();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(29);
    expect(second.generatedPassword).toBeNull();
    expect(await Listing.countDocuments({})).toBe(29);
    expect(await User.countDocuments({ username: DEMO_HOST.username })).toBe(1);
  });

  test("a second run keeps reviews and restores edited seed fields", async () => {
    await runSeed();
    const listing = await Listing.findOne({ title: "Mountain Retreat" });
    const { user } = await createUser();
    await createReview({ listing, author: user });
    await Listing.updateOne(
      { _id: listing._id },
      { "pricing.nightlyMinor": 10000 },
    );

    await runSeed();
    const again = await Listing.findById(listing._id);
    expect(again.pricing.nightlyMinor).toBe(100000);
    expect(again.status).toBe("published");
    expect(again.reviews).toHaveLength(1);
    expect(await Review.countDocuments({})).toBe(1);
  });

  test("--reset re-creates the listings and removes only their reviews", async () => {
    await runSeed();
    const seeded = await Listing.findOne({ title: "Mountain Retreat" });
    const { user: other } = await createUser();
    await createReview({ listing: seeded, author: other });

    const mine = await createListing({ owner: other, title: "Someone Else's Home" });
    const keptReview = await createReview({ listing: mine, author: other });

    const summary = await runSeed({ reset: true });
    expect(summary.removed).toBe(29);
    expect(summary.created).toBe(29);
    expect(summary.total).toBe(29);

    expect(await Listing.countDocuments({})).toBe(30);
    expect(await Listing.findById(mine._id)).not.toBeNull();
    expect(await Review.findById(keptReview._id)).not.toBeNull();
    expect(await Review.countDocuments({})).toBe(1);
  });
});
