// Abandoned drafts (P04-T02): a draft nobody has touched for 90 days is not a
// listing anyone is going to finish. This deletes them (and their uploaded
// photos). It is a plain function so the sweeper job (P07-T07) can call it on
// a schedule; nothing calls it yet.
const DEFAULT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} Listing the model
 * @param {object} [options]
 * @param {Date}   [options.now]
 * @param {number} [options.days]
 * @param {(publicId: string) => Promise<unknown>} [options.destroy] removes one
 *        photo from storage; errors are ignored (a leftover photo is not worth failing)
 * @returns {Promise<{ deleted: number, photosRemoved: number }>}
 */
async function deleteStaleDrafts(
  Listing,
  { now = new Date(), days = DEFAULT_DAYS, destroy } = {},
) {
  const cutoff = new Date();
  cutoff.setTime(now.getTime() - days * DAY_MS);
  const stale = await Listing.find({
    status: "draft",
    updatedAt: { $lt: cutoff },
  })
    .select("images image")
    .lean();

  let deleted = 0;
  let photosRemoved = 0;
  for (const draft of stale) {
    // Re-check in the delete itself: a host who saved a step a moment ago keeps
    // the draft, and a draft that was published meanwhile is never touched.
    const result = await Listing.deleteOne({
      _id: draft._id,
      status: "draft",
      updatedAt: { $lt: cutoff },
    });
    if (!result || result.deletedCount !== 1) continue;
    deleted += 1;
    if (!destroy) continue;
    const ids = (draft.images || [])
      .map((photo) => photo.publicId)
      .filter(Boolean);
    for (const id of ids) {
      try {
        await destroy(id);
        photosRemoved += 1;
      } catch {
        // best effort
      }
    }
  }
  return { deleted, photosRemoved };
}

module.exports = { deleteStaleDrafts, DEFAULT_DAYS };
