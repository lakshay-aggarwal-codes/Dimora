// Approximate public location (P06-T02).
//
// Gives every listing with a precise point its public (approximate) point, and
// builds the 2dsphere index on it. A listing whose stored public point already
// equals the one computed now is left alone; a listing with no usable precise
// point loses any public point it has. Safe to run again.
//
// UNLIKE the other migrations this one uses the app's own function
// (src/utils/geo.js), not a frozen copy: the public point must be exactly what
// the app computes on save, or every listing would be rewritten at its next save.
// It needs SESSION_SECRET (the key of the offsets) in the environment, as the
// app does; scripts/migrate.js loads .env.
//
// Changing SESSION_SECRET changes every public point. Run this migration again
// after (delete its record in schema_migrations first), or save the listings.
const BATCH_SIZE = 500;
const INDEX = [{ publicGeometry: "2dsphere" }, { name: "publicGeometry_2dsphere" }];

function sameCoordinates(a, b) {
  return (
    Array.isArray(a) && Array.isArray(b) && a.length === 2 && b.length === 2 && a[0] === b[0] && a[1] === b[1]
  );
}

/** Pure: what each listing needs. `geo` is src/utils/geo (injected for tests). */
function planPublicGeometry(listings, geo) {
  const updates = [];
  const counts = { scanned: listings.length, toSet: 0, toUnset: 0 };
  for (const listing of listings) {
    const wanted = geo.approximatePoint(listing.geometry, String(listing._id));
    const stored = listing.publicGeometry;
    if (wanted) {
      if (!(stored && stored.type === "Point" && sameCoordinates(stored.coordinates, wanted.coordinates))) {
        updates.push({ _id: listing._id, set: { publicGeometry: wanted } });
        counts.toSet += 1;
      }
    } else if (stored !== undefined && stored !== null) {
      updates.push({ _id: listing._id, unset: { publicGeometry: "" } });
      counts.toUnset += 1;
    }
  }
  return { updates, counts };
}

module.exports = {
  async up(db, ctx = {}) {
    const geo = require("../../src/utils/geo");
    geo.configureLocationSecret(process.env.SESSION_SECRET);

    const listings = db.collection("listings");
    const documents = await listings
      .find({}, { projection: { geometry: 1, publicGeometry: 1 } })
      .toArray();
    const plan = planPublicGeometry(documents, geo);
    if (ctx.dryRun) return { ...plan.counts, indexes: 1 };

    let modified = 0;
    for (let i = 0; i < plan.updates.length; i += BATCH_SIZE) {
      const operations = plan.updates.slice(i, i + BATCH_SIZE).map(({ _id, set, unset }) => ({
        updateOne: { filter: { _id }, update: set ? { $set: set } : { $unset: unset } },
      }));
      const result = await listings.bulkWrite(operations, { ordered: false });
      modified += result.modifiedCount || 0;
    }
    await listings.createIndex(INDEX[0], INDEX[1]);
    return { scanned: plan.counts.scanned, updated: modified, indexes: 1 };
  },

  /** Manual rollback (the runner only calls `up`): drops the index and the public points. */
  async down(db, ctx = {}) {
    const listings = db.collection("listings");
    if (ctx.dryRun) return { indexes: 1 };
    try {
      await listings.dropIndex(INDEX[1].name);
    } catch (err) {
      if (!err || err.codeName !== "IndexNotFound") throw err;
    }
    await listings.updateMany({}, { $unset: { publicGeometry: "" } });
    return { indexesDropped: 1 };
  },

  planPublicGeometry,
};
