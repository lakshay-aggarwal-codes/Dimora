// The pure part of migration 009 (no database): which ratings count, and what
// "already right" means.
const {
  totalsOf,
} = require("../../scripts/migrations/009-listing-rating-sums");

describe("migration 009 totalsOf", () => {
  test("only whole 1 to 5 count", () => {
    expect(totalsOf([5, 4, 4.5, undefined, 0, "5", null, 6])).toEqual({
      ratingSum: 9,
      ratingCount: 2,
      ratingAvg: 4.5,
    });
    expect(totalsOf([])).toEqual({
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
    });
  });
});

describe("migration 009 with a fake database", () => {
  const { up } = require("../../scripts/migrations/009-listing-rating-sums");
  const fakeDb = (listings, reviews) => {
    const writes = [];
    return {
      writes,
      collection: (name) =>
        name === "listings"
          ? {
              find: () =>
                (async function* () {
                  for (const l of listings) yield l;
                })(),
              bulkWrite: async (ops) => {
                writes.push(...ops);
                return { modifiedCount: ops.length };
              },
            }
          : {
              find: (filter) => ({
                toArray: async () =>
                  reviews.filter((r) =>
                    filter._id.$in.some((id) => String(id) === String(r._id)),
                  ),
              }),
            },
    };
  };
  const reviews = [
    { _id: "a", rating: 5 },
    { _id: "b", rating: 3 },
  ];

  test("it writes only the listings whose numbers are wrong", async () => {
    const listings = [
      {
        _id: 1,
        reviews: ["a", "b"],
        ratingSum: 8,
        ratingCount: 2,
        ratingAvg: 4,
      },
      { _id: 2, reviews: ["a", "b"], ratingCount: 2, ratingAvg: 3 },
      { _id: 3 },
    ];
    const db = fakeDb(listings, reviews);
    expect(await up(db, {})).toEqual({ scanned: 3, toUpdate: 2, modified: 2 });
    expect(db.writes.map((w) => w.updateOne.filter._id)).toEqual([2, 3]);
    expect(db.writes[0].updateOne.update.$set).toEqual({
      ratingSum: 8,
      ratingCount: 2,
      ratingAvg: 4,
    });
    expect(db.writes[1].updateOne.update.$set).toEqual({
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
    });
  });

  test("a dry run writes nothing", async () => {
    const db = fakeDb([{ _id: 2, reviews: ["a"] }], reviews);
    expect(await up(db, { dryRun: true })).toEqual({ scanned: 1, toUpdate: 1 });
    expect(db.writes).toHaveLength(0);
  });
});
