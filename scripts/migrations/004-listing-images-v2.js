// Listing photos v2 (P04-T03).
//
// For every listing with photos in images[]:
//   - `filename` (the Cloudinary id) is renamed `publicId`
//   - every photo gets an `_id` (the photo routes identify a photo by it)
//   - `order` is made to match the position in the array
//   - `alt` is added (empty) so the field exists
// Listings with no images[] are left alone. Nothing is deleted except the
// `filename` key of photos whose value moved to `publicId`.
//
// Safe to run again: a photo that already has `_id`, `publicId` and the right
// `order` is not touched, and a listing with no change is not written.
// `down` is a manual rollback (the runner only calls `up`).
// mongoose.mongo is the MongoDB driver mongoose already depends on.
const { ObjectId } = require("mongoose").mongo;

const BATCH_SIZE = 500;

/** The upgraded photo, or null when it needs no change. */
function upgradeImage(image, index, makeId) {
  if (!image || typeof image !== "object") return null;
  const next = { ...image };
  let changed = false;

  if (next._id === undefined || next._id === null) {
    next._id = makeId();
    changed = true;
  }
  if ("filename" in next) {
    if (next.publicId === undefined) next.publicId = next.filename || "";
    delete next.filename;
    changed = true;
  }
  if (next.publicId === undefined) {
    next.publicId = "";
    changed = true;
  }
  if (next.alt === undefined) {
    next.alt = "";
    changed = true;
  }
  if (next.order !== index) {
    next.order = index;
    changed = true;
  }
  return changed ? next : image;
}

/** Pure planner: which listings change, and to what. */
function planImageMigration(documents, makeId = () => new ObjectId()) {
  const updates = [];
  const counts = {
    scanned: documents.length,
    listingsToUpdate: 0,
    photosUpgraded: 0,
  };
  for (const doc of documents) {
    const images = Array.isArray(doc.images) ? doc.images : [];
    if (images.length === 0) continue;
    // Keep the stored display order: sort by `order`, ties by position.
    const sorted = images
      .map((image, position) => ({ image, position }))
      .sort(
        (a, b) =>
          (a.image && a.image.order !== undefined ? a.image.order : 0) -
            (b.image && b.image.order !== undefined ? b.image.order : 0) ||
          a.position - b.position,
      )
      .map((item) => item.image);
    let upgraded = 0;
    const result = sorted.map((image, index) => {
      const next = upgradeImage(image, index, makeId);
      if (next !== image) upgraded += 1;
      return next === null ? image : next;
    });
    const reordered = sorted.some((image, index) => image !== images[index]);
    if (upgraded === 0 && !reordered) continue;
    updates.push({ _id: doc._id, images: result });
    counts.listingsToUpdate += 1;
    counts.photosUpgraded += upgraded;
  }
  return { updates, counts };
}

module.exports = {
  async up(db, ctx = {}) {
    const listings = db.collection("listings");
    const documents = await listings
      .find({ "images.0": { $exists: true } })
      .toArray();
    const plan = planImageMigration(documents);
    if (ctx.dryRun) return plan.counts;

    for (let i = 0; i < plan.updates.length; i += BATCH_SIZE) {
      const batch = plan.updates.slice(i, i + BATCH_SIZE);
      await listings.bulkWrite(
        batch.map(({ _id, images }) => ({
          updateOne: { filter: { _id }, update: { $set: { images } } },
        })),
      );
    }
    if (ctx.log) {
      ctx.log(
        `listings updated: ${plan.counts.listingsToUpdate}, photos upgraded: ${plan.counts.photosUpgraded}`,
      );
    }
    return plan.counts;
  },

  // Manual rollback: publicId back to filename, ids and alt text kept.
  async down(db) {
    const listings = db.collection("listings");
    const documents = await listings
      .find({ "images.0": { $exists: true } })
      .toArray();
    for (const doc of documents) {
      const images = doc.images.map((image) => {
        const { publicId, ...rest } = image;
        return { ...rest, filename: publicId || "" };
      });
      await listings.updateOne({ _id: doc._id }, { $set: { images } });
    }
  },

  upgradeImage,
  planImageMigration,
};
