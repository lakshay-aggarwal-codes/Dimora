// P12-T02 against a real MongoDB: the rating totals are one atomic update per
// review, so reviews written and deleted at the same moment never lose a
// total, and the stored numbers always equal a recomputation from the reviews.
// Skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const {
  createUser,
  createListing,
  createCompletedStay,
} = require("../helpers/factories");
const { prng } = require("../helpers/bookingStress");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const reviewService = require("../../src/services/reviews");
const ratings = require("../../src/services/ratings");

describeDb("rating totals (database)", () => {
  useTestDb();

  async function world(guestCount) {
    const { user: host } = await createUser();
    const listing = await createListing({ owner: host._id });
    const guests = [];
    for (let i = 0; i < guestCount; i += 1) {
      const { user } = await createUser();
      const stay = await createCompletedStay({ listing, guest: user });
      guests.push({ user, stay });
    }
    return { listing, guests };
  }

  async function expectTotalsMatchReviews(listingId) {
    const listing = await Listing.findById(listingId).lean();
    const reviews = await Review.find({ listing: listingId }).lean();
    const truth = ratings.totalsOf(reviews);
    expect(listing.ratingSum).toBe(truth.ratingSum);
    expect(listing.ratingCount).toBe(truth.ratingCount);
    expect(listing.ratingAvg).toBeCloseTo(truth.ratingAvg, 9);
    expect(listing.reviews.map(String).sort()).toEqual(
      reviews.map((r) => String(r._id)).sort(),
    );
  }

  const write = ({ user, stay }, listing, stars) =>
    reviewService.submit({
      user,
      listingId: String(listing._id),
      reservationId: String(stay._id),
      rating: String(stars),
      comment: "Fine.",
    });

  test("30 reviews at the same moment: every one is counted", async () => {
    const { listing, guests } = await world(30);
    const rng = prng(7);
    await Promise.all(guests.map((g) => write(g, listing, rng.int(1, 5))));
    expect((await Listing.findById(listing._id)).ratingCount).toBe(30);
    await expectTotalsMatchReviews(listing._id);
  });

  test("writing and deleting at the same moment, in waves, stays equal to a recomputation", async () => {
    const { listing, guests } = await world(24);
    const rng = prng(11);
    const written = [];
    let next = 0;
    for (let wave = 0; wave < 12; wave += 1) {
      const tasks = [];
      for (let i = 0; i < 4 && next < guests.length; i += 1) {
        const g = guests[next++];
        tasks.push(
          write(g, listing, rng.int(1, 5)).then((r) => written.push(r)),
        );
      }
      const deletable = written.splice(0, Math.min(2, written.length));
      for (const r of deletable)
        tasks.push(
          reviewService.remove({
            listingId: String(listing._id),
            reviewId: r._id,
          }),
        );
      await Promise.all(tasks);
      await expectTotalsMatchReviews(listing._id);
    }
  });

  test("deleting the same review from two requests subtracts once", async () => {
    const { listing, guests } = await world(2);
    const a = await write(guests[0], listing, 5);
    await write(guests[1], listing, 1);
    const results = await Promise.all([
      reviewService.remove({ listingId: String(listing._id), reviewId: a._id }),
      reviewService.remove({ listingId: String(listing._id), reviewId: a._id }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await Listing.findById(listing._id);
    expect(after).toMatchObject({ ratingSum: 1, ratingCount: 1, ratingAvg: 1 });
  });

  test("a listing saved with the old fields only (no ratingSum) starts from zero", async () => {
    const { listing, guests } = await world(1);
    await Listing.collection.updateOne(
      { _id: listing._id },
      { $unset: { ratingSum: "", ratingCount: "", ratingAvg: "" } },
    );
    await write(guests[0], listing, 4);
    expect(await Listing.findById(listing._id)).toMatchObject({
      ratingSum: 4,
      ratingCount: 1,
      ratingAvg: 4,
    });
  });
});
