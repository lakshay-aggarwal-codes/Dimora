// Migration 008 (review model v2) against a real MongoDB: old reviews become
// legacy, get their listing from the parent array and real timestamps, lose the
// misspelt crestedAt, and the new unique index allows one review per stay.
const mongoose = require("mongoose");
const { ObjectId } = require("mongoose").Types;
const { describeDb, useTestDb } = require("../helpers/db");
const Review = require("../../src/models/review");
const { up } = require("../../scripts/migrations/008-review-model-v2");

describeDb("migration 008 (reviews)", () => {
  useTestDb();

  async function seed() {
    const db = mongoose.connection.db;
    const reviews = db.collection("reviews");
    const listings = db.collection("listings");
    const older = new ObjectId(
      Math.floor(Date.parse("2024-03-01T00:00:00Z") / 1000),
    );
    const newer = new ObjectId(
      Math.floor(Date.parse("2025-06-01T00:00:00Z") / 1000),
    );
    const orphan = new ObjectId();
    const sameDate = new Date("2020-01-01T00:00:00Z");
    await reviews.insertMany([
      {
        _id: older,
        rating: 4,
        comment: "Old",
        author: new ObjectId(),
        crestedAt: sameDate,
      },
      {
        _id: newer,
        rating: 5,
        comment: "Newer",
        author: new ObjectId(),
        crestedAt: sameDate,
        createdAt: new Date("2025-06-02T00:00:00Z"),
        updatedAt: new Date("2025-06-02T00:00:00Z"),
      },
      {
        _id: orphan,
        rating: 3,
        comment: "No listing holds me",
        crestedAt: sameDate,
      },
    ]);
    const { insertedId: listingId } = await listings.insertOne({
      title: "L",
      reviews: [older, newer],
    });
    return { db, reviews, older, newer, orphan, listingId };
  }

  test("a dry run only counts", async () => {
    const { reviews } = await seed();
    const result = await up(mongoose.connection.db, { dryRun: true });
    expect(result).toMatchObject({
      scanned: 3,
      toMarkLegacy: 3,
      withoutListing: 3,
      withCrestedAt: 3,
    });
    expect(await reviews.countDocuments({ legacy: true })).toBe(0);
  });

  test("upgrades every review, keeps content, and is safe to run twice", async () => {
    const { reviews, older, newer, orphan, listingId } = await seed();
    const first = await up(mongoose.connection.db, {});
    expect(first).toMatchObject({
      scanned: 3,
      markedLegacy: 3,
      linkedToListing: 2,
      crestedAtRemoved: 3,
    });

    const a = await reviews.findOne({ _id: older });
    expect(a).toMatchObject({ rating: 4, comment: "Old", legacy: true });
    expect(String(a.listing)).toBe(String(listingId));
    expect(a.crestedAt).toBeUndefined();
    expect(a.createdAt.toISOString().slice(0, 10)).toBe("2024-03-01"); // from the _id, not the shared default
    expect(a.updatedAt).toEqual(a.createdAt);

    const b = await reviews.findOne({ _id: newer });
    expect(b.createdAt.toISOString().slice(0, 10)).toBe("2025-06-02"); // an existing date is kept
    expect(String(b.listing)).toBe(String(listingId));

    const c = await reviews.findOne({ _id: orphan });
    expect(c.legacy).toBe(true);
    expect(c.listing).toBeUndefined();

    const second = await up(mongoose.connection.db, {});
    expect(second).toMatchObject({
      markedLegacy: 0,
      linkedToListing: 0,
      crestedAtRemoved: 0,
      datesSet: 0,
    });
    expect(await reviews.countDocuments({ legacy: true })).toBe(3);
  });

  test("a review of a stay is not marked legacy", async () => {
    const { reviews } = await seed();
    const reservation = new ObjectId();
    await reviews.insertOne({
      rating: 5,
      comment: "Real",
      reservation,
      legacy: false,
    });
    await up(mongoose.connection.db, {});
    expect((await reviews.findOne({ reservation })).legacy).toBe(false);
  });

  test("builds the unique index: one review per reservation, any number without one", async () => {
    await seed();
    await up(mongoose.connection.db, {});
    await Review.init();
    const reservation = new ObjectId();
    await Review.create({ rating: 5, comment: "One", reservation });
    await expect(
      Review.create({ rating: 4, comment: "Two", reservation }),
    ).rejects.toMatchObject({ code: 11000 });
    await Review.create({ rating: 3, comment: "No stay A" });
    await Review.create({ rating: 3, comment: "No stay B" });
    const names = (await Review.collection.indexes()).map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "reservation_1_unique",
        "listing_1_createdAt_-1",
        "author_1_createdAt_-1",
      ]),
    );
  });
});
