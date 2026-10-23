// Review model v2 (P12-T01, ADR-010).
//
//   1. every review that is not tied to a reservation gets `legacy: true`
//      (content, rating and author are kept; nothing is deleted);
//   2. `listing` is filled from the listing whose `reviews` array holds the
//      review (a review that no listing holds keeps no `listing`);
//   3. the misspelt `crestedAt` (its default was evaluated once at load, so
//      every review got the same date) is removed, and a review without
//      `createdAt`/`updatedAt` gets the time its _id was created, which is
//      when it was written;
//   4. the indexes of the v2 model are built.
// Safe to run again: every step only touches documents that still need it.
// A dry run only counts.
const UNIQUE = [
  { reservation: 1 },
  {
    name: "reservation_1_unique",
    unique: true,
    partialFilterExpression: { reservation: { $type: "objectId" } },
  },
];
const BY_LISTING = [
  { listing: 1, createdAt: -1 },
  { name: "listing_1_createdAt_-1" },
];
const BY_AUTHOR = [
  { author: 1, createdAt: -1 },
  { name: "author_1_createdAt_-1" },
];

const NO_RESERVATION = {
  reservation: { $exists: false },
  legacy: { $exists: false },
};
const NO_LISTING = { listing: { $exists: false } };
const NO_DATES = { createdAt: { $exists: false } };

module.exports = {
  async up(db, ctx = {}) {
    const reviews = db.collection("reviews");
    const listings = db.collection("listings");

    const counts = {
      scanned: await reviews.countDocuments({}),
      toMarkLegacy: await reviews.countDocuments(NO_RESERVATION),
      withoutListing: await reviews.countDocuments(NO_LISTING),
      withoutDates: await reviews.countDocuments(NO_DATES),
      withCrestedAt: await reviews.countDocuments({
        crestedAt: { $exists: true },
      }),
    };
    if (ctx.dryRun) return { ...counts, indexes: 3 };

    // 2. listing from the parent array (a review held by two listings is a data
    //    error; the first listing in _id order wins and later ones are skipped
    //    because the filter requires `listing` to be missing).
    let linked = 0;
    const cursor = listings
      .find({ "reviews.0": { $exists: true } }, { projection: { reviews: 1 } })
      .sort({ _id: 1 });
    for await (const listing of cursor) {
      const result = await reviews.updateMany(
        { _id: { $in: listing.reviews }, ...NO_LISTING },
        { $set: { listing: listing._id } },
      );
      linked += result.modifiedCount;
    }

    // 1. legacy
    const legacy = await reviews.updateMany(NO_RESERVATION, {
      $set: { legacy: true },
    });

    // 3. timestamps, then the misspelt field
    const dated = await reviews.updateMany(NO_DATES, [
      {
        $set: {
          createdAt: { $toDate: "$_id" },
          updatedAt: { $ifNull: ["$updatedAt", { $toDate: "$_id" }] },
        },
      },
    ]);
    const undated = await reviews.updateMany(
      { createdAt: { $exists: true }, updatedAt: { $exists: false } },
      [{ $set: { updatedAt: "$createdAt" } }],
    );
    const cleaned = await reviews.updateMany(
      { crestedAt: { $exists: true } },
      { $unset: { crestedAt: "" } },
    );

    // 4. indexes
    await reviews.createIndex(...UNIQUE);
    await reviews.createIndex(...BY_LISTING);
    await reviews.createIndex(...BY_AUTHOR);

    return {
      ...counts,
      linkedToListing: linked,
      markedLegacy: legacy.modifiedCount,
      datesSet: dated.modifiedCount + undated.modifiedCount,
      crestedAtRemoved: cleaned.modifiedCount,
      indexes: 3,
    };
  },
};
