// Listing model v2 (P04-T01).
//
// For every listing, fills in only what is missing:
//   - status "published" (every listing that exists today is already public)
//   - pricing.nightlyMinor = old `price` (rupees) x 100, rounded to a whole
//     paise; the old value is kept in `legacyPrice` and `price` is removed
//   - address.city / address.country guessed from location / country
//   - images[] from the old single `image`
//   - defaults for the new fields (timezone, capacity, nights, check-in/out
//     times, cancellation policy, rating aggregates, ...)
//   - createdAt / updatedAt (from the document id)
//   - needsReview: true when the address was guessed, the price is missing or
//     under the INR 100 floor, or the listing has no coordinates
// and builds the four indexes the model declares.
//
// Nothing is deleted except the `price` field, whose value moves to
// `legacyPrice`. Listings without a usable price keep no pricing.nightlyMinor
// (and show "Price not set") rather than getting an invented one. Safe to run
// again: every step skips what is already there.
//
// Run it BEFORE starting a version of the app with the v2 model. Until then
// old listings load but show no price. `down` (below) undoes the data change;
// the runner only calls `up`, so `down` is a manual, documented rollback.
const BATCH_SIZE = 500;
const FLOOR_MINOR = 10000;
const INDEXES = [
  [{ status: 1, "address.city": 1 }, { name: "status_1_address.city_1" }],
  [{ owner: 1, status: 1 }, { name: "owner_1_status_1" }],
  [
    { title: "text", description: "text" },
    { name: "title_text_description_text" },
  ],
  [{ "pricing.nightlyMinor": 1 }, { name: "pricing.nightlyMinor_1" }],
];

const present = (value) => value !== undefined;
const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Old price (rupees) -> paise, or null if it is not a usable amount. */
function legacyPriceToMinor(price) {
  const n = typeof price === "string" && price.trim() ? Number(price) : price;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const minor = Math.round(n * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

function createdAtFromId(id) {
  return id && typeof id.getTimestamp === "function"
    ? id.getTimestamp()
    : new Date();
}

function ratingFor(listing, ratingsById) {
  const ids = Array.isArray(listing.reviews) ? listing.reviews : [];
  let sum = 0;
  let count = 0;
  for (const id of ids) {
    const rating = ratingsById.get(String(id));
    if (typeof rating === "number" && Number.isFinite(rating)) {
      sum += rating;
      count += 1;
    }
  }
  return {
    count,
    avg: count ? Math.round((sum / count) * 100) / 100 : 0,
  };
}

/**
 * Pure planning step.
 * @param {object[]} listings raw listing documents
 * @param {Map<string, number>} ratingsById review id (string) -> rating
 * @returns {{ updates: {_id: *, set: object, unset?: object}[], counts: object }}
 */
function planListingMigration(listings, ratingsById = new Map()) {
  const updates = [];
  const counts = {
    scanned: listings.length,
    toUpdate: 0,
    published: 0,
    priceConverted: 0,
    withoutPrice: 0,
    belowFloor: 0,
    addressDerived: 0,
    imagesSeeded: 0,
    withoutGeometry: 0,
    flaggedForReview: 0,
  };

  for (const listing of listings) {
    const set = {};
    const unset = {};
    let flag = false;
    const defaultTo = (path, value, current) => {
      if (!present(current)) set[path] = value;
    };

    // status
    if (!present(listing.status)) {
      set.status = "published";
      counts.published += 1;
    }

    // price: rupees -> paise
    const pricing = listing.pricing || {};
    let nightly = pricing.nightlyMinor;
    if (!present(nightly) || nightly === null) {
      const minor = legacyPriceToMinor(listing.price);
      if (minor === null) {
        counts.withoutPrice += 1;
        flag = true;
        nightly = undefined;
      } else {
        set["pricing.nightlyMinor"] = minor;
        counts.priceConverted += 1;
        nightly = minor;
      }
    }
    if (typeof nightly === "number" && nightly < FLOOR_MINOR) {
      counts.belowFloor += 1;
      flag = true;
    }
    defaultTo("pricing.cleaningFeeMinor", 0, pricing.cleaningFeeMinor);
    defaultTo("pricing.currency", "INR", pricing.currency);
    if (present(listing.price)) {
      if (!present(listing.legacyPrice)) set.legacyPrice = listing.price;
      unset.price = "";
    }

    // address
    const address = listing.address;
    const hasAddress =
      address &&
      typeof address === "object" &&
      (text(address.city) || text(address.country) || text(address.line1));
    if (!hasAddress) {
      const guess = {};
      if (text(listing.location)) guess.city = text(listing.location);
      if (text(listing.country)) guess.country = text(listing.country);
      if (Object.keys(guess).length) {
        for (const [k, v] of Object.entries(guess)) set[`address.${k}`] = v;
        counts.addressDerived += 1;
      }
      flag = true;
    }

    // images
    const hasImages = Array.isArray(listing.images) && listing.images.length;
    if (!hasImages && listing.image && text(listing.image.url)) {
      set.images = [
        {
          url: listing.image.url,
          filename: text(listing.image.filename),
          caption: "",
          order: 0,
        },
      ];
      counts.imagesSeeded += 1;
    }

    // coordinates
    const geometry = listing.geometry;
    if (
      !geometry ||
      !Array.isArray(geometry.coordinates) ||
      geometry.coordinates.length !== 2
    ) {
      counts.withoutGeometry += 1;
      flag = true;
    }

    // other defaults
    const capacity = listing.capacity || {};
    defaultTo("timezone", "Asia/Kolkata", listing.timezone);
    defaultTo("capacity.guests", 2, capacity.guests);
    defaultTo("capacity.bedrooms", 1, capacity.bedrooms);
    defaultTo("capacity.beds", 1, capacity.beds);
    defaultTo("capacity.bathrooms", 1, capacity.bathrooms);
    defaultTo("amenities", [], listing.amenities);
    defaultTo("checkInTime", "14:00", listing.checkInTime);
    defaultTo("checkOutTime", "11:00", listing.checkOutTime);
    defaultTo("minNights", 1, listing.minNights);
    defaultTo("maxNights", 30, listing.maxNights);
    defaultTo("instantBook", false, listing.instantBook);
    defaultTo("cancellationPolicy", "moderate", listing.cancellationPolicy);

    // rating aggregates, from the reviews the listing already has
    if (!present(listing.ratingAvg) || !present(listing.ratingCount)) {
      const { avg, count } = ratingFor(listing, ratingsById);
      defaultTo("ratingAvg", avg, listing.ratingAvg);
      defaultTo("ratingCount", count, listing.ratingCount);
    }

    // timestamps
    const created = present(listing.createdAt)
      ? listing.createdAt
      : createdAtFromId(listing._id);
    defaultTo("createdAt", created, listing.createdAt);
    defaultTo("updatedAt", created, listing.updatedAt);

    // needsReview: never turned off here (a host does that when confirming)
    if (listing.needsReview !== true) {
      if (flag) {
        set.needsReview = true;
        counts.flaggedForReview += 1;
      } else if (!present(listing.needsReview)) {
        set.needsReview = false;
      }
    } else if (flag) {
      counts.flaggedForReview += 1;
    }

    const hasSet = Object.keys(set).length > 0;
    const hasUnset = Object.keys(unset).length > 0;
    if (hasSet || hasUnset) {
      const update = { _id: listing._id, set };
      if (hasUnset) update.unset = unset;
      updates.push(update);
    }
  }

  counts.toUpdate = updates.length;
  return { updates, counts };
}

async function loadRatings(db, listings) {
  const ids = [
    ...new Set(
      listings.flatMap((l) => (Array.isArray(l.reviews) ? l.reviews : [])),
    ),
  ];
  const ratings = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db
      .collection("reviews")
      .find({ _id: { $in: ids.slice(i, i + 1000) } }, { projection: { rating: 1 } })
      .toArray();
    for (const row of rows) ratings.set(String(row._id), row.rating);
  }
  return ratings;
}

module.exports = {
  async up(db, ctx = {}) {
    const listings = db.collection("listings");
    const documents = await listings.find({}).toArray();
    const ratings = await loadRatings(db, documents);
    const plan = planListingMigration(documents, ratings);

    if (ctx.dryRun) {
      return { ...plan.counts, indexes: INDEXES.length };
    }

    let modified = 0;
    for (let i = 0; i < plan.updates.length; i += BATCH_SIZE) {
      const operations = plan.updates
        .slice(i, i + BATCH_SIZE)
        .map(({ _id, set, unset }) => {
          const update = {};
          if (Object.keys(set).length) update.$set = set;
          if (unset) update.$unset = unset;
          return { updateOne: { filter: { _id }, update } };
        });
      const result = await listings.bulkWrite(operations, { ordered: false });
      modified += result.modifiedCount || 0;
    }

    for (const [spec, options] of INDEXES) {
      await listings.createIndex(spec, options);
    }

    return {
      scanned: plan.counts.scanned,
      updated: modified,
      priceConverted: plan.counts.priceConverted,
      flaggedForReview: plan.counts.flaggedForReview,
      indexes: INDEXES.length,
    };
  },

  /**
   * Manual rollback (the runner does not call it; see docs/MIGRATIONS.md).
   * Puts `legacyPrice` back as `price` and drops the indexes. It leaves the
   * new fields in place (old code ignores them) and does not undo `status`.
   */
  async down(db, ctx = {}) {
    const listings = db.collection("listings");
    const filter = { legacyPrice: { $exists: true }, price: { $exists: false } };
    const todo = await listings.countDocuments(filter);
    if (ctx.dryRun) return { wouldRestorePrice: todo };
    await listings.updateMany(filter, [
      { $set: { price: "$legacyPrice" } },
      { $unset: "legacyPrice" },
    ]);
    for (const [, options] of INDEXES) {
      try {
        await listings.dropIndex(options.name);
      } catch (err) {
        if (err && err.codeName !== "IndexNotFound") throw err;
      }
    }
    return { restoredPrice: todo, indexesDropped: INDEXES.length };
  },

  // exported for tests
  planListingMigration,
  legacyPriceToMinor,
};
