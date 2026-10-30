// Rating aggregates of a listing (P12-T02): `ratingSum`, `ratingCount` and
// `ratingAvg` (= sum / count, 0 when there is no review).
//
// Every change is ONE atomic update of the listing document, written as an
// update pipeline that adds to the sum and the count and derives the average
// from the new values inside the same operation. Nothing is read first, so two
// reviews written at the same moment can never overwrite each other's total
// (a recompute from a stale read could).
//
// The same update also adds or removes the review in `listing.reviews`, so the
// list and the totals never disagree.
//
//   ratingUpdate({ add: { reviewId, stars } })      a review was written
//   ratingUpdate({ remove: { reviewId, stars } })   a review was deleted
//   ratingUpdate({ change: { from, to } })          a review's rating was edited
//   recomputeRatings(...)                           repair from the reviews themselves

const RATING = Object.freeze({ MIN: 1, MAX: 5 });

/** Only whole ratings 1 to 5 count towards an aggregate. */
const isCountable = (stars) =>
  Number.isInteger(stars) && stars >= RATING.MIN && stars <= RATING.MAX;

/** Stages that derive the average from the sum and count already in the document. */
const averageStage = {
  $set: {
    ratingAvg: {
      $cond: [
        { $gt: ["$ratingCount", 0] },
        { $divide: ["$ratingSum", "$ratingCount"] },
        0,
      ],
    },
  },
};

/**
 * The update pipeline for one review being added, removed or re-rated.
 * @param {{ add?: {reviewId: *, stars: number}, remove?: {reviewId: *, stars: number},
 *           change?: {from: number, to: number} }} change
 */
function ratingUpdate(change) {
  const { add, remove, change: rerate } = change;
  if ([add, remove, rerate].filter(Boolean).length !== 1)
    throw new TypeError("give exactly one of add, remove and change");
  if (rerate) {
    // The review stays in the list; only the sum (and the count, if the old
    // rating was not countable) move. Still one atomic update.
    const { from, to } = rerate;
    const sumDelta =
      (isCountable(to) ? to : 0) - (isCountable(from) ? from : 0);
    const countDelta = (isCountable(to) ? 1 : 0) - (isCountable(from) ? 1 : 0);
    return [
      {
        $set: {
          ratingSum: {
            $max: [0, { $add: [{ $ifNull: ["$ratingSum", 0] }, sumDelta] }],
          },
          ratingCount: {
            $max: [0, { $add: [{ $ifNull: ["$ratingCount", 0] }, countDelta] }],
          },
        },
      },
      averageStage,
    ];
  }
  const { reviewId, stars } = add || remove;
  const sign = add ? 1 : -1;
  const counted = isCountable(stars);

  const reviews = add
    ? { $concatArrays: [{ $ifNull: ["$reviews", []] }, [reviewId]] }
    : {
        $filter: {
          input: { $ifNull: ["$reviews", []] },
          as: "id",
          cond: { $ne: ["$$id", reviewId] },
        },
      };

  const set = { reviews };
  if (counted) {
    // Never below zero, even if the totals were already wrong.
    set.ratingSum = {
      $max: [0, { $add: [{ $ifNull: ["$ratingSum", 0] }, sign * stars] }],
    };
    set.ratingCount = {
      $max: [0, { $add: [{ $ifNull: ["$ratingCount", 0] }, sign] }],
    };
  }
  return counted ? [{ $set: set }, averageStage] : [{ $set: set }];
}

/** A review was written: add it to the list and the totals, in one update. */
function addReview(ListingModel, listingId, review) {
  return ListingModel.updateOne(
    { _id: listingId },
    ratingUpdate({ add: { reviewId: review._id, stars: review.rating } }),
    { updatePipeline: true },
  );
}

/** A review was deleted: take it out of the list and the totals, in one update. */
function removeReview(ListingModel, listingId, review) {
  return ListingModel.updateOne(
    { _id: listingId },
    ratingUpdate({ remove: { reviewId: review._id, stars: review.rating } }),
    { updatePipeline: true },
  );
}

/** A review's rating was edited: move the totals by the difference, in one update. */
function changeRating(ListingModel, listingId, { from, to }) {
  return ListingModel.updateOne(
    { _id: listingId },
    ratingUpdate({ change: { from, to } }),
    { updatePipeline: true },
  );
}

/**
 * Set a listing's totals from its reviews (repair, and migration 009). The
 * reviews are the truth; use it when the totals are suspected wrong, not on
 * every write.
 * @returns {{ ratingSum: number, ratingCount: number, ratingAvg: number }}
 */
function totalsOf(reviews) {
  const ratings = (Array.isArray(reviews) ? reviews : [])
    .map((r) => (r ? r.rating : undefined))
    .filter(isCountable);
  const ratingSum = ratings.reduce((total, r) => total + r, 0);
  const ratingCount = ratings.length;
  return {
    ratingSum,
    ratingCount,
    ratingAvg: ratingCount > 0 ? ratingSum / ratingCount : 0,
  };
}

async function recomputeRatings({ ListingModel, ReviewModel }, listingId) {
  const listing = await ListingModel.findById(listingId)
    .select("reviews")
    .lean();
  if (!listing) return null;
  const reviews = await ReviewModel.find({
    _id: { $in: listing.reviews || [] },
    status: { $ne: "hidden" }, // a hidden review is not in the totals (P14-T04)
  })
    .select("rating")
    .lean();
  const totals = totalsOf(reviews);
  await ListingModel.updateOne({ _id: listingId }, { $set: totals });
  return totals;
}

module.exports = {
  RATING,
  isCountable,
  ratingUpdate,
  addReview,
  removeReview,
  changeRating,
  totalsOf,
  recomputeRatings,
};
