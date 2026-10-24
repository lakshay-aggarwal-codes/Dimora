// P14-T04: hiding and restoring a review keeps the listing's rating totals
// right, in one atomic update, with in-memory fakes (no database).
const { ObjectId } = require("mongoose").Types;
const moderation = require("../../src/services/reviewModeration");
const reviews = require("../../src/services/reviews");
const ratings = require("../../src/services/ratings");
const { applyPipeline } = require("../helpers/pipelineEval");
const { prng } = require("../helpers/bookingStress");

const ADMIN = { _id: new ObjectId(), role: "admin", status: "active" };
const LISTING_ID = new ObjectId();

function world({ stars = [5, 4, 2], legacyNoListing = false } = {}) {
  const docs = stars.map((rating) => ({
    _id: new ObjectId(),
    rating,
    comment: "c",
    listing: legacyNoListing ? undefined : LISTING_ID,
    reservation: new ObjectId(),
  }));
  const state = {
    listing: {
      _id: LISTING_ID,
      reviews: docs.map((r) => r._id),
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
    },
    failNext: 0,
  };
  Object.assign(state.listing, ratings.totalsOf(docs));
  const matches = (doc, filter) =>
    Object.entries(filter).every(([key, cond]) => {
      if (key === "_id") return String(doc._id) === String(cond);
      if (cond && typeof cond === "object" && "$ne" in cond)
        return doc[key] !== cond.$ne;
      return doc[key] === cond;
    });
  const apply = (doc, update) => {
    for (const [k, v] of Object.entries(update.$set || {})) {
      if (k.includes(".")) {
        const [a, b] = k.split(".");
        doc[a] = { ...(doc[a] || {}), [b]: v };
      } else doc[k] = v;
    }
    for (const k of Object.keys(update.$unset || {})) delete doc[k];
  };
  const lean = (value) => ({
    lean: async () => value,
    select: () => ({ lean: async () => value }),
  });
  const ReviewModel = {
    docs,
    findOneAndUpdate: jest.fn((filter, update) => {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) apply(doc, update);
      return lean(doc ? { ...doc } : null);
    }),
    exists: jest.fn(async (filter) =>
      docs.some((d) => matches(d, filter)) ? { _id: 1 } : null,
    ),
    updateOne: jest.fn(async (filter, update) => {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) apply(doc, update);
    }),
  };
  const ListingModel = {
    state,
    updateOne: jest.fn(async (filter, update) => {
      await Promise.resolve();
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new Error("listing update failed");
      }
      state.listing = applyPipeline(state.listing, update);
      return { matchedCount: 1 };
    }),
    findOne: jest.fn(() => lean(state.listing)),
  };
  const hide = (i, reason = "Contains personal details", over = {}) =>
    moderation.hideReview({
      admin: ADMIN,
      id: String(docs[i]._id),
      reason,
      ReviewModel,
      ListingModel,
      ...over,
    });
  const restore = (i, reason = "Reported by mistake", over = {}) =>
    moderation.restoreReview({
      admin: ADMIN,
      id: String(docs[i]._id),
      reason,
      ReviewModel,
      ListingModel,
      ...over,
    });
  return { docs, state, ReviewModel, ListingModel, hide, restore };
}

describe("hideReview", () => {
  test("the review is hidden, leaves the list and the totals, and the details are for the audit row", async () => {
    const w = world();
    const done = await w.hide(0);
    expect(w.docs[0]).toMatchObject({
      status: "hidden",
      moderation: {
        hiddenBy: ADMIN._id,
        hiddenReason: "Contains personal details",
      },
    });
    expect(w.docs[0].moderation.hiddenAt).toBeInstanceOf(Date);
    expect(w.state.listing).toMatchObject({ ratingSum: 6, ratingCount: 2 });
    expect(w.state.listing.ratingAvg).toBeCloseTo(3, 12);
    expect(w.state.listing.reviews.map(String)).not.toContain(
      String(w.docs[0]._id),
    );
    expect(done.reason).toBe("Contains personal details");
    expect(done.details).toEqual({ rating: 5, listingId: String(LISTING_ID) });
  });

  test("restoring puts it back in the list and the totals", async () => {
    const w = world();
    await w.hide(0);
    await w.restore(0);
    expect(w.docs[0].status).toBe("visible");
    expect(w.docs[0].moderation).toBeUndefined();
    expect(w.state.listing).toMatchObject({ ratingSum: 11, ratingCount: 3 });
    expect(w.state.listing.reviews.map(String)).toContain(
      String(w.docs[0]._id),
    );
  });

  test("hiding twice, and restoring something that is not hidden, are refused with nothing changed", async () => {
    const w = world();
    await w.hide(1);
    const before = JSON.stringify(w.state.listing);
    await expect(w.hide(1)).rejects.toThrow("already hidden");
    await expect(w.restore(0)).rejects.toThrow("not hidden");
    expect(JSON.stringify(w.state.listing)).toBe(before);
  });

  test("two admins hiding at the same moment: one wins, the totals change once", async () => {
    const w = world();
    const results = await Promise.allSettled([w.hide(0), w.hide(0)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason).toBeInstanceOf(
      moderation.ReviewModerationError,
    );
    expect(w.state.listing).toMatchObject({ ratingSum: 6, ratingCount: 2 });
  });

  test("a failed listing update puts the review back to visible (status and totals never disagree)", async () => {
    const w = world();
    w.state.failNext = 1;
    await expect(w.hide(0)).rejects.toThrow("listing update failed");
    expect(w.docs[0].status).toBe("visible");
    expect(w.state.listing).toMatchObject({ ratingSum: 11, ratingCount: 3 });
  });

  test("a failed update on restore hides it again", async () => {
    const w = world();
    await w.hide(0);
    w.state.failNext = 1;
    await expect(w.restore(0)).rejects.toThrow("listing update failed");
    expect(w.docs[0].status).toBe("hidden");
  });

  test("a legacy review with no listing field is found through the listing that holds it", async () => {
    const w = world({ legacyNoListing: true });
    await w.hide(0);
    expect(w.ListingModel.findOne).toHaveBeenCalledWith({
      reviews: w.docs[0]._id,
    });
    expect(w.state.listing.ratingCount).toBe(2);
  });

  test.each([[undefined], [""], ["    "], ["no"], ["x".repeat(501)], [5]])(
    "a reason of %j is refused before anything changes",
    async (reason) => {
      const w = world();
      await expect(
        moderation.hideReview({
          admin: ADMIN,
          id: String(w.docs[0]._id),
          reason,
          ReviewModel: w.ReviewModel,
          ListingModel: w.ListingModel,
        }),
      ).rejects.toBeInstanceOf(moderation.ReviewModerationError);
      expect(w.ReviewModel.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  test.each([["nope"], [""], [undefined], [{}]])(
    "a bad id %j is a plain refusal",
    async (id) => {
      const w = world();
      await expect(
        moderation.hideReview({
          admin: ADMIN,
          id,
          reason: "Valid reason here",
          ReviewModel: w.ReviewModel,
          ListingModel: w.ListingModel,
        }),
      ).rejects.toThrow("does not exist");
    },
  );

  test("a review that does not exist", async () => {
    const w = world();
    await expect(
      moderation.hideReview({
        admin: ADMIN,
        id: String(new ObjectId()),
        reason: "Valid reason here",
        ReviewModel: w.ReviewModel,
        ListingModel: w.ListingModel,
      }),
    ).rejects.toThrow("does not exist");
  });
});

describe("hiding and the other review paths", () => {
  function withReviewService(w) {
    const created = [];
    const ReviewModel = {
      ...w.ReviewModel,
      findOneAndDelete: jest.fn(async (filter) => {
        const i = w.docs.findIndex((d) => String(d._id) === String(filter._id));
        return i === -1 ? null : w.docs.splice(i, 1)[0];
      }),
      create: jest.fn(async (d) => created.push(d)),
    };
    return reviews.createReviewService({
      ReviewModel,
      ListingModel: w.ListingModel,
      ReservationModel: {},
    });
  }

  test("the author deleting a hidden review does not subtract it a second time", async () => {
    const w = world();
    await w.hide(0);
    const before = JSON.stringify(w.state.listing);
    const removed = await withReviewService(w).remove({
      listingId: String(LISTING_ID),
      reviewId: w.docs[0]._id,
    });
    expect(removed.status).toBe("hidden");
    expect(JSON.stringify(w.state.listing)).toBe(before);
    expect(w.state.listing.ratingCount).toBe(2);
  });

  test("deleting a visible review still subtracts it", async () => {
    const w = world();
    await withReviewService(w).remove({
      listingId: String(LISTING_ID),
      reviewId: w.docs[1]._id,
    });
    expect(w.state.listing).toMatchObject({ ratingSum: 7, ratingCount: 2 });
  });

  test("a hidden review is not in a recomputation of the totals", async () => {
    const w = world();
    await w.hide(0);
    // the listing no longer holds it, and the repair query also excludes hidden ones
    let asked;
    const ReviewModel = {
      find: (filter) => (
        (asked = filter),
        {
          select: () => ({
            lean: async () => w.docs.filter((d) => d.status !== "hidden"),
          }),
        }
      ),
    };
    const ListingModel = {
      ...w.ListingModel,
      findById: () => ({
        select: () => ({ lean: async () => w.state.listing }),
      }),
      updateOne: jest.fn(),
    };
    expect(
      await ratings.recomputeRatings({ ListingModel, ReviewModel }, LISTING_ID),
    ).toMatchObject({ ratingSum: 6, ratingCount: 2 });
    expect(asked.status).toEqual({ $ne: "hidden" });
  });
});

describe("the totals always equal a recomputation of the visible reviews (random hides and restores)", () => {
  test.each([1, 2, 3])("seed %i", async (seed) => {
    const rng = prng(seed);
    const w = world({ stars: Array.from({ length: 12 }, () => rng.int(1, 5)) });
    for (let i = 0; i < 300; i += 1) {
      const tasks = [];
      for (let k = 0; k < rng.int(1, 4); k += 1) {
        const index = rng.int(0, w.docs.length - 1);
        tasks.push(
          (rng.next() < 0.5 ? w.hide(index) : w.restore(index)).catch((err) => {
            if (!(err instanceof moderation.ReviewModerationError)) throw err; // refusals are fine
          }),
        );
      }
      await Promise.all(tasks);
      const visible = w.docs.filter((d) => d.status !== "hidden");
      const truth = ratings.totalsOf(visible);
      expect(w.state.listing.ratingSum).toBe(truth.ratingSum);
      expect(w.state.listing.ratingCount).toBe(truth.ratingCount);
      expect(w.state.listing.ratingAvg).toBeCloseTo(truth.ratingAvg, 12);
      expect(w.state.listing.reviews.map(String).sort()).toEqual(
        visible.map((d) => String(d._id)).sort(),
      );
    }
  });
});
