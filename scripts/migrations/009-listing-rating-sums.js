// Rating totals (P12-T02): gives every listing `ratingSum`, and makes
// `ratingCount` and `ratingAvg` agree with the reviews the listing holds.
// Only whole ratings 1 to 5 count. A listing whose three numbers already match
// is left alone, so it is safe to run again; a dry run only counts.
// After this, services/ratings.js keeps the numbers right with atomic updates.
const BATCH_SIZE = 500;

const countable = (r) => Number.isInteger(r) && r >= 1 && r <= 5;

/** Pure: the three numbers for a list of ratings. */
function totalsOf(ratings) {
  const good = ratings.filter(countable);
  const ratingSum = good.reduce((t, r) => t + r, 0);
  const ratingCount = good.length;
  return {
    ratingSum,
    ratingCount,
    ratingAvg: ratingCount > 0 ? ratingSum / ratingCount : 0,
  };
}

const same = (listing, totals) =>
  listing.ratingSum === totals.ratingSum &&
  listing.ratingCount === totals.ratingCount &&
  Math.abs((listing.ratingAvg || 0) - totals.ratingAvg) < 1e-9;

module.exports = {
  totalsOf,
  async up(db, ctx = {}) {
    const listings = db.collection("listings");
    const reviews = db.collection("reviews");
    const counts = { scanned: 0, toUpdate: 0 };
    const updates = [];

    const cursor = listings.find(
      {},
      {
        projection: { reviews: 1, ratingSum: 1, ratingCount: 1, ratingAvg: 1 },
      },
    );
    for await (const listing of cursor) {
      counts.scanned += 1;
      const ids = Array.isArray(listing.reviews) ? listing.reviews : [];
      const docs =
        ids.length > 0
          ? await reviews
              .find({ _id: { $in: ids } }, { projection: { rating: 1 } })
              .toArray()
          : [];
      const totals = totalsOf(docs.map((r) => r.rating));
      if (!same(listing, totals)) {
        counts.toUpdate += 1;
        updates.push({ _id: listing._id, totals });
      }
    }
    if (ctx.dryRun) return counts;

    let modified = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const result = await listings.bulkWrite(
        updates
          .slice(i, i + BATCH_SIZE)
          .map(({ _id, totals }) => ({
            updateOne: { filter: { _id }, update: { $set: totals } },
          })),
        { ordered: false },
      );
      modified += result.modifiedCount;
    }
    return { ...counts, modified };
  },
};
