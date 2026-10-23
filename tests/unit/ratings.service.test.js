// P12-T02: the rating aggregates. The update pipelines are run by a small
// interpreter (tests/helpers/pipelineEval.js), so what is checked is what the
// pipeline computes. The real database is exercised by
// tests/integration/ratings.db.test.js.
const { ObjectId } = require("mongoose").Types;
const ratings = require("../../src/services/ratings");
const { applyPipeline } = require("../helpers/pipelineEval");
const { prng } = require("../helpers/bookingStress");

const listingDoc = (extra = {}) => ({
  _id: new ObjectId(),
  reviews: [],
  ratingSum: 0,
  ratingCount: 0,
  ratingAvg: 0,
  ...extra,
});
const review = (stars) => ({ _id: new ObjectId(), rating: stars });

/** A listing model whose updateOne applies the pipeline atomically (synchronously) to its one document. */
function fakeListings(doc) {
  const model = {
    doc,
    calls: [],
    updateOne: jest.fn(async (filter, update) => {
      model.calls.push([filter, update]);
      if (String(filter._id) !== String(model.doc._id))
        return { matchedCount: 0, modifiedCount: 0 };
      model.doc = Array.isArray(update)
        ? applyPipeline(model.doc, update)
        : { ...model.doc, ...update.$set };
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };
  return model;
}

describe("ratingUpdate", () => {
  test("adding a review: totals up, average derived, id appended, in one pipeline", () => {
    const r = review(4);
    const out = applyPipeline(
      listingDoc({
        ratingSum: 9,
        ratingCount: 2,
        ratingAvg: 4.5,
        reviews: [new ObjectId(), new ObjectId()],
      }),
      ratings.ratingUpdate({ add: { reviewId: r._id, stars: 4 } }),
    );
    expect(out).toMatchObject({ ratingSum: 13, ratingCount: 3 });
    expect(out.ratingAvg).toBeCloseTo(13 / 3, 12);
    expect(out.reviews).toHaveLength(3);
    expect(String(out.reviews[2])).toBe(String(r._id));
  });

  test("removing a review: totals down, id removed, average follows; the last one leaves 0", () => {
    const a = review(5);
    const b = review(2);
    let doc = listingDoc({
      reviews: [a._id, b._id],
      ratingSum: 7,
      ratingCount: 2,
      ratingAvg: 3.5,
    });
    doc = applyPipeline(
      doc,
      ratings.ratingUpdate({ remove: { reviewId: a._id, stars: 5 } }),
    );
    expect(doc).toMatchObject({ ratingSum: 2, ratingCount: 1, ratingAvg: 2 });
    expect(doc.reviews.map(String)).toEqual([String(b._id)]);
    doc = applyPipeline(
      doc,
      ratings.ratingUpdate({ remove: { reviewId: b._id, stars: 2 } }),
    );
    expect(doc).toMatchObject({
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
      reviews: [],
    });
  });

  test("a listing that has no totals yet (old data) starts from zero", () => {
    const out = applyPipeline(
      { _id: new ObjectId() },
      ratings.ratingUpdate({ add: { reviewId: new ObjectId(), stars: 5 } }),
    );
    expect(out).toMatchObject({ ratingSum: 5, ratingCount: 1, ratingAvg: 5 });
    expect(out.reviews).toHaveLength(1);
  });

  test("totals never go below zero, even when they were already wrong", () => {
    const r = review(5);
    const out = applyPipeline(
      listingDoc({ reviews: [r._id], ratingSum: 2, ratingCount: 0 }),
      ratings.ratingUpdate({ remove: { reviewId: r._id, stars: 5 } }),
    );
    expect(out.ratingSum).toBe(0);
    expect(out.ratingCount).toBe(0);
    expect(out.ratingAvg).toBe(0);
  });

  test.each([[undefined], [null], [0], [6], [4.5], ["5"], [NaN]])(
    "a rating of %j changes the list but not the totals",
    (stars) => {
      const r = { _id: new ObjectId(), rating: stars };
      const before = listingDoc({
        ratingSum: 9,
        ratingCount: 2,
        ratingAvg: 4.5,
      });
      const added = applyPipeline(
        before,
        ratings.ratingUpdate({ add: { reviewId: r._id, stars } }),
      );
      expect(added).toMatchObject({
        ratingSum: 9,
        ratingCount: 2,
        ratingAvg: 4.5,
      });
      expect(added.reviews).toHaveLength(1);
    },
  );

  test("exactly one of add and remove", () => {
    expect(() => ratings.ratingUpdate({})).toThrow(TypeError);
    expect(() =>
      ratings.ratingUpdate({
        add: { reviewId: 1, stars: 1 },
        remove: { reviewId: 1, stars: 1 },
      }),
    ).toThrow(TypeError);
  });

  test("the pipeline reads nothing outside the document (no stale value can be written)", () => {
    const text = JSON.stringify(
      ratings.ratingUpdate({ add: { reviewId: "x", stars: 3 } }),
    );
    expect(text).not.toMatch(/\$set":\{"ratingAvg":\d/); // the average is derived, never a number computed outside
    expect(
      ratings.ratingUpdate({ add: { reviewId: "x", stars: 3 } }),
    ).toHaveLength(2);
  });
});

describe("totalsOf", () => {
  test("only whole 1 to 5 count", () => {
    expect(
      ratings.totalsOf([
        { rating: 5 },
        { rating: 4 },
        { rating: 4.5 },
        { rating: 0 },
        { rating: "5" },
        {},
        null,
      ]),
    ).toEqual({ ratingSum: 9, ratingCount: 2, ratingAvg: 4.5 });
    expect(ratings.totalsOf([])).toEqual({
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
    });
    expect(ratings.totalsOf(undefined)).toEqual({
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
    });
  });
});

describe("the aggregate always equals a recomputation (random operations)", () => {
  test.each([1, 2, 3, 20261023])(
    "seed %i: 500 adds and deletes, some at the same moment",
    async (seed) => {
      const rng = prng(seed);
      const model = fakeListings(listingDoc());
      const live = new Map(); // id -> review
      for (let i = 0; i < 500; i += 1) {
        const width = rng.int(1, 6);
        const tasks = [];
        for (let w = 0; w < width; w += 1) {
          if (live.size === 0 || rng.next() < 0.6) {
            // one in ten reviews has no countable rating (legacy data)
            const stars = rng.next() < 0.1 ? undefined : rng.int(1, 5);
            const r = { _id: new ObjectId(), rating: stars };
            live.set(String(r._id), r);
            tasks.push(ratings.addReview(model, model.doc._id, r));
          } else {
            const id = rng.pick([...live.keys()]);
            const r = live.get(id);
            live.delete(id);
            tasks.push(ratings.removeReview(model, model.doc._id, r));
          }
        }
        await Promise.all(tasks);
        const truth = ratings.totalsOf([...live.values()]);
        expect(model.doc.ratingSum).toBe(truth.ratingSum);
        expect(model.doc.ratingCount).toBe(truth.ratingCount);
        expect(model.doc.ratingAvg).toBeCloseTo(truth.ratingAvg, 12);
        expect(model.doc.reviews.map(String).sort()).toEqual(
          [...live.keys()].sort(),
        );
      }
    },
  );

  test("why it is one atomic update: a read-then-write version loses reviews written at the same moment", async () => {
    // The naive version (what the card rules out): read the totals, add, write back.
    const naive = listingDoc();
    const addNaively = async (stars) => {
      const seen = { ...naive }; // read
      await Promise.resolve(); // another request runs here
      naive.ratingSum = seen.ratingSum + stars; // write from the stale read
      naive.ratingCount = seen.ratingCount + 1;
    };
    await Promise.all([5, 4, 3, 2, 1].map(addNaively));
    expect(naive.ratingCount).toBeLessThan(5); // updates were lost

    const model = fakeListings(listingDoc());
    await Promise.all(
      [5, 4, 3, 2, 1].map((stars) =>
        ratings.addReview(model, model.doc._id, review(stars)),
      ),
    );
    expect(model.doc).toMatchObject({
      ratingCount: 5,
      ratingSum: 15,
      ratingAvg: 3,
    });
  });
});

describe("recomputeRatings (repair)", () => {
  test("sets the totals from the reviews the listing holds", async () => {
    const r1 = review(5);
    const r2 = review(3);
    const model = fakeListings(
      listingDoc({
        reviews: [r1._id, r2._id],
        ratingSum: 99,
        ratingCount: 99,
        ratingAvg: 5,
      }),
    );
    model.findById = () => ({
      select: () => ({ lean: async () => model.doc }),
    });
    const ReviewModel = {
      find: () => ({ select: () => ({ lean: async () => [r1, r2] }) }),
    };
    expect(
      await ratings.recomputeRatings(
        { ListingModel: model, ReviewModel },
        model.doc._id,
      ),
    ).toEqual({ ratingSum: 8, ratingCount: 2, ratingAvg: 4 });
    expect(model.doc).toMatchObject({
      ratingSum: 8,
      ratingCount: 2,
      ratingAvg: 4,
    });
  });
  test("a missing listing gives null", async () => {
    const ListingModel = {
      findById: () => ({ select: () => ({ lean: async () => null }) }),
    };
    expect(
      await ratings.recomputeRatings(
        { ListingModel, ReviewModel: {} },
        new ObjectId(),
      ),
    ).toBeNull();
  });
});
