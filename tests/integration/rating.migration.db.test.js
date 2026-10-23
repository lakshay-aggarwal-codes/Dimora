// Migration 009 against a real MongoDB: every listing gets ratingSum, and
// ratingCount / ratingAvg agree with the reviews it holds. Needs a MongoDB.
const mongoose = require("mongoose");
const { ObjectId } = require("mongoose").Types;
const { describeDb, useTestDb } = require("../helpers/db");
const { up } = require("../../scripts/migrations/009-listing-rating-sums");

describeDb("migration 009 (rating totals)", () => {
  useTestDb();

  async function seed() {
    const db = mongoose.connection.db;
    const reviews = db.collection("reviews");
    const listings = db.collection("listings");
    const r = [5, 4, 4.5, undefined, 0].map((rating) => ({
      _id: new ObjectId(),
      ...(rating === undefined ? {} : { rating }),
    }));
    await reviews.insertMany(r);
    const { insertedId: wrong } = await listings.insertOne({
      title: "Wrong totals",
      reviews: r.map((x) => x._id),
      ratingCount: 9,
      ratingAvg: 2,
    });
    const { insertedId: right } = await listings.insertOne({
      title: "Already right",
      reviews: [r[0]._id, r[1]._id],
      ratingSum: 9,
      ratingCount: 2,
      ratingAvg: 4.5,
    });
    const { insertedId: none } = await listings.insertOne({
      title: "No reviews",
      reviews: [],
    });
    const { insertedId: bare } = await listings.insertOne({
      title: "Old document",
    });
    return { listings, wrong, right, none, bare };
  }

  test("a dry run only counts", async () => {
    const { listings, wrong } = await seed();
    const result = await up(mongoose.connection.db, { dryRun: true });
    expect(result).toEqual({ scanned: 4, toUpdate: 3 });
    expect((await listings.findOne({ _id: wrong })).ratingSum).toBeUndefined();
  });

  test("only whole 1 to 5 ratings count; listings already right are left alone; safe to run twice", async () => {
    const { listings, wrong, right, none, bare } = await seed();
    const first = await up(mongoose.connection.db, {});
    expect(first).toMatchObject({ scanned: 4, toUpdate: 3, modified: 3 });
    expect(await listings.findOne({ _id: wrong })).toMatchObject({
      ratingSum: 9,
      ratingCount: 2,
      ratingAvg: 4.5,
    });
    expect(await listings.findOne({ _id: right })).toMatchObject({
      ratingSum: 9,
      ratingCount: 2,
      ratingAvg: 4.5,
    });
    expect(await listings.findOne({ _id: none })).toMatchObject({
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
    });
    expect(await listings.findOne({ _id: bare })).toMatchObject({
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
    });
    const second = await up(mongoose.connection.db, {});
    expect(second).toMatchObject({ toUpdate: 0, modified: 0 });
  });
});
