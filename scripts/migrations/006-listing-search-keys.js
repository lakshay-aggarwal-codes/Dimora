// Search keys and indexes (P05-T01).
//
// Fills cityKey, stateKey, countryKey and locationKey (lower-case, accent-free
// copies of the address) on every listing whose keys are missing or out of date,
// and builds the two compound indexes the search uses. Nothing else changes.
// Safe to run again: a listing whose keys are already right is not touched.
//
// The key rules below are a frozen copy of src/utils/searchKeys.js as of this
// task, on purpose: a migration must keep doing what it did when it was written.
// tests/unit/searchMigration.test.js checks the copy still agrees with the app.
const BATCH_SIZE = 500;
const INDEXES = [
  [
    { status: 1, cityKey: 1, "pricing.nightlyMinor": 1 },
    { name: "status_1_cityKey_1_pricing.nightlyMinor_1" },
  ],
  [
    { status: 1, countryKey: 1, "pricing.nightlyMinor": 1 },
    { name: "status_1_countryKey_1_pricing.nightlyMinor_1" },
  ],
];

function normaliseToken(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function keysFor(listing) {
  const address = (listing && listing.address) || {};
  let city = address.city ?? (listing && listing.location);
  let state = address.state;
  if (typeof city === "string" && city.includes(",")) {
    const [first, second] = city.split(",").map((part) => part.trim());
    city = first;
    if (!state && second) state = second;
  }
  const cityKey = normaliseToken(city);
  const stateKey = normaliseToken(state);
  const countryKey = normaliseToken(address.country ?? (listing && listing.country));
  return {
    cityKey,
    stateKey,
    countryKey,
    locationKey: [cityKey, stateKey, countryKey].filter(Boolean).join("|"),
  };
}

/** Pure: which listings need which keys. */
function planSearchKeys(listings) {
  const updates = [];
  for (const listing of listings) {
    const wanted = keysFor(listing);
    const set = {};
    for (const [name, value] of Object.entries(wanted)) {
      if (listing[name] !== value) set[name] = value;
    }
    if (Object.keys(set).length) updates.push({ _id: listing._id, set });
  }
  return { updates, counts: { scanned: listings.length, toUpdate: updates.length } };
}

module.exports = {
  async up(db, ctx = {}) {
    const listings = db.collection("listings");
    const documents = await listings
      .find(
        {},
        {
          projection: {
            address: 1,
            location: 1,
            country: 1,
            cityKey: 1,
            stateKey: 1,
            countryKey: 1,
            locationKey: 1,
          },
        },
      )
      .toArray();
    const plan = planSearchKeys(documents);
    if (ctx.dryRun) return { ...plan.counts, indexes: INDEXES.length };

    let modified = 0;
    for (let i = 0; i < plan.updates.length; i += BATCH_SIZE) {
      const operations = plan.updates.slice(i, i + BATCH_SIZE).map(({ _id, set }) => ({
        updateOne: { filter: { _id }, update: { $set: set } },
      }));
      const result = await listings.bulkWrite(operations, { ordered: false });
      modified += result.modifiedCount || 0;
    }
    for (const [spec, options] of INDEXES) {
      await listings.createIndex(spec, options);
    }
    return { scanned: plan.counts.scanned, updated: modified, indexes: INDEXES.length };
  },

  /** Manual rollback (the runner only calls `up`): drops the two indexes and the keys. */
  async down(db, ctx = {}) {
    const listings = db.collection("listings");
    if (ctx.dryRun) return { indexes: INDEXES.length };
    for (const [, options] of INDEXES) {
      try {
        await listings.dropIndex(options.name);
      } catch (err) {
        if (!err || err.codeName !== "IndexNotFound") throw err;
      }
    }
    await listings.updateMany(
      {},
      { $unset: { cityKey: "", stateKey: "", countryKey: "", locationKey: "" } },
    );
    return { indexesDropped: INDEXES.length };
  },

  // exported for tests
  planSearchKeys,
  keysFor,
  normaliseToken,
};
