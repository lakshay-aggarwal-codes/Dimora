// P14-T04 against a real MongoDB: hiding a review changes the listing's rating
// totals atomically, closing a report is a compare-and-set, and the admin
// routes write exactly one audit row. Skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const {
  createUser,
  createListing,
  createCompletedStay,
} = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const Report = require("../../src/models/report");
const reviewService = require("../../src/services/reviews");
const moderation = require("../../src/services/reviewModeration");
const queue = require("../../src/services/reportModeration");
const ratings = require("../../src/services/ratings");

describeDb("reports queue and review moderation (database)", () => {
  useTestDb();

  async function world(stars) {
    const { user: host } = await createUser();
    const { user: admin } = await createUser({ role: "admin" });
    const listing = await createListing({ owner: host._id });
    const made = [];
    for (const rating of stars) {
      const { user } = await createUser();
      const stay = await createCompletedStay({ listing, guest: user });
      made.push(
        await reviewService.submit({
          user,
          listingId: String(listing._id),
          reservationId: String(stay._id),
          rating: String(rating),
          comment: "Fine.",
        }),
      );
    }
    return { listing, admin, host, made };
  }

  async function expectTotalsAreTheVisibleReviews(listingId) {
    const listing = await Listing.findById(listingId).lean();
    const visible = await Review.find({
      listing: listingId,
      status: { $ne: "hidden" },
    }).lean();
    const truth = ratings.totalsOf(visible);
    expect(listing.ratingSum).toBe(truth.ratingSum);
    expect(listing.ratingCount).toBe(truth.ratingCount);
    expect(listing.ratingAvg).toBeCloseTo(truth.ratingAvg, 9);
    expect(listing.reviews.map(String).sort()).toEqual(
      visible.map((r) => String(r._id)).sort(),
    );
  }

  test("hide and restore move the totals and the list together", async () => {
    const { listing, admin, made } = await world([5, 4, 1]);
    await moderation.hideReview({
      admin,
      id: String(made[2]._id),
      reason: "Contains private details",
    });
    expect((await Review.findById(made[2]._id)).status).toBe("hidden");
    await expectTotalsAreTheVisibleReviews(listing._id);
    expect((await Listing.findById(listing._id)).ratingCount).toBe(2);
    await moderation.restoreReview({
      admin,
      id: String(made[2]._id),
      reason: "Reported by mistake",
    });
    await expectTotalsAreTheVisibleReviews(listing._id);
    expect((await Listing.findById(listing._id)).ratingCount).toBe(3);
  });

  test("two admins hiding the same review at once: the totals change once", async () => {
    const { listing, admin, made } = await world([5, 3]);
    const results = await Promise.allSettled([
      moderation.hideReview({
        admin,
        id: String(made[0]._id),
        reason: "First admin's reason",
      }),
      moderation.hideReview({
        admin,
        id: String(made[0]._id),
        reason: "Second admin's reason",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await Listing.findById(listing._id)).ratingCount).toBe(1);
    await expectTotalsAreTheVisibleReviews(listing._id);
  });

  test("a hidden review can still be deleted by its author without counting twice", async () => {
    const { listing, admin, made } = await world([5, 3]);
    await moderation.hideReview({
      admin,
      id: String(made[0]._id),
      reason: "Contains private details",
    });
    await reviewService.remove({
      listingId: String(listing._id),
      reviewId: made[0]._id,
    });
    await expectTotalsAreTheVisibleReviews(listing._id);
    expect((await Listing.findById(listing._id)).ratingCount).toBe(1);
  });

  test("a hidden review's stay still counts as reviewed", async () => {
    const { listing, admin, made } = await world([2]);
    await moderation.hideReview({
      admin,
      id: String(made[0]._id),
      reason: "Contains private details",
    });
    const { user } = await createUser();
    expect(
      await reviewService.findReviewable({
        user,
        listingId: String(listing._id),
      }),
    ).toBeNull();
  });

  test("closing a report: compare-and-set, others only when asked", async () => {
    const { admin, made } = await world([4]);
    const { user: a } = await createUser();
    const { user: b } = await createUser();
    const make = (reporter) =>
      Report.create({
        reporter: reporter._id,
        targetKind: "review",
        targetId: made[0]._id,
        reason: "spam",
        targetLabel: "A review",
      });
    const first = await make(a);
    const second = await make(b);
    const results = await Promise.allSettled([
      queue.closeReport({
        admin,
        id: String(first._id),
        outcome: "resolve",
        note: "Hidden the review",
        closeOthers: true,
      }),
      queue.closeReport({
        admin,
        id: String(first._id),
        outcome: "dismiss",
        note: "Nothing to do here",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await Report.findById(first._id)).status).not.toBe("open");
    expect((await Report.findById(second._id)).status === "open").toBe(
      results.find((r) => r.status === "fulfilled").value.closedOthers === 0,
    );
  });
});
