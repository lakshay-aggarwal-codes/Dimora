// Saving stays to a member's wishlist (P10-T01).
//
// setSaved(...) says what the final state should be ("saved" or "not saved"),
// not "flip it", so a double click or a retried request cannot undo itself.
// `ListingStat.saves` follows the rows: +1 only when a row was really created,
// -n only for the n rows really deleted.
const { LIMITS, DEFAULT_NAME } = require("../config/wishlists");
const { toCardItem } = require("../utils/listingCard");
const {
  NotFoundError,
  ConflictError,
  ValidationError,
} = require("../utils/errors");

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// Models are looked up on first use so a test can pass fakes through `deps`.
function models(deps = {}) {
  return {
    Wishlist: deps.Wishlist || require("../models/wishlist"),
    WishlistItem: deps.WishlistItem || require("../models/wishlistItem"),
    ListingStat: deps.ListingStat || require("../models/listingStat"),
    stats: deps.stats || require("./listingStats"),
    Listing: deps.Listing || require("../models/listing"),
    now: deps.now || (() => new Date()),
  };
}

const isPublic = (listing) =>
  Boolean(listing) && listing.status === "published" && !listing.deletedAt;

/** The member's default list, created on first use. */
async function ensureDefaultList(userId, deps) {
  const { Wishlist } = models(deps);
  const find = () => Wishlist.findOne({ owner: userId, isDefault: true }).lean();
  const existing = await find();
  if (existing) return existing;
  try {
    return await Wishlist.findOneAndUpdate(
      { owner: userId, isDefault: true },
      {
        $setOnInsert: { owner: userId, name: DEFAULT_NAME, isDefault: true },
      },
      { upsert: true, new: true },
    ).lean();
  } catch (err) {
    // Two requests created it at once: the unique index let one win.
    if (err && err.code === 11000) return find();
    throw err;
  }
}

/**
 * Makes the stay saved (`saved` true) or not saved (false) for this member.
 * @returns {Promise<{ saved: boolean, changed: boolean }>}
 */
async function setSaved(userId, listingId, saved, deps) {
  const { WishlistItem, ListingStat, Listing, stats, now } = models(deps);
  if (typeof saved !== "boolean") {
    throw new ValidationError("Say whether to save or to remove this stay.");
  }
  if (!OBJECT_ID.test(String(listingId))) {
    throw new NotFoundError("That stay does not exist.");
  }

  if (!saved) {
    // Removing is always allowed, also for a stay that is no longer public.
    const result = await WishlistItem.deleteMany({
      owner: userId,
      listing: listingId,
    });
    const removed = result.deletedCount || 0;
    if (removed > 0) {
      await ListingStat.updateOne(
        { listing: listingId },
        { $inc: { saves: -removed } },
        { upsert: true },
      );
      await stats.clampSaves(listingId); // never below zero (P13-T03)
    }
    return { saved: false, changed: removed > 0 };
  }

  const listing = await Listing.findById(listingId)
    .select("status deletedAt")
    .lean();
  if (!isPublic(listing)) {
    throw new NotFoundError("That stay is not available.");
  }

  const list = await ensureDefaultList(userId, deps);
  const already = await WishlistItem.findOne({
    wishlist: list._id,
    listing: listingId,
  }).lean();
  if (already) return { saved: true, changed: false };

  // Not exact under a burst of parallel requests (two can both see 99); the
  // overshoot is bounded by the number of simultaneous requests.
  const count = await WishlistItem.countDocuments({ wishlist: list._id });
  if (count >= LIMITS.maxItems) {
    throw new ConflictError(
      `Your saved list is full (${LIMITS.maxItems} stays). Remove one to save another.`,
    );
  }

  const result = await WishlistItem.updateOne(
    { wishlist: list._id, listing: listingId },
    {
      $setOnInsert: {
        wishlist: list._id,
        owner: userId,
        listing: listingId,
        createdAt: now(),
      },
    },
    { upsert: true },
  );
  const created = (result.upsertedCount || 0) > 0;
  if (created) {
    await ListingStat.updateOne(
      { listing: listingId },
      { $inc: { saves: 1 } },
      { upsert: true },
    );
    await stats.recordSave(listingId); // daily count for the host (P13-T03)
  }
  return { saved: true, changed: created };
}

/** ids (as strings) of every stay this member has saved, for the heart state. */
async function savedIdsFor(userId, deps) {
  if (!userId) return new Set();
  const { WishlistItem } = models(deps);
  const rows = await WishlistItem.find({ owner: userId })
    .select("listing")
    .limit(LIMITS.maxLists * LIMITS.maxItems)
    .lean();
  return new Set(rows.map((row) => String(row.listing)));
}

/**
 * The saved-stays page: newest first. A stay that is no longer public (hidden,
 * deleted, suspended) stays in the list as "no longer available" so the member
 * sees what happened and can remove it; it is never dropped silently.
 */
async function overview(userId, deps) {
  const { WishlistItem, Listing } = models(deps);
  const rows = await WishlistItem.find({ owner: userId })
    .sort({ createdAt: -1 })
    .limit(LIMITS.maxLists * LIMITS.maxItems)
    .lean();
  const listings = rows.length
    ? await Listing.find({ _id: { $in: rows.map((row) => row.listing) } })
        .select("title image location country pricing status deletedAt")
        .lean()
    : [];
  const byId = new Map(listings.map((l) => [String(l._id), l]));
  const items = rows.map((row) => {
    const listing = byId.get(String(row.listing));
    const available = isPublic(listing);
    return {
      id: String(row.listing),
      available,
      title: (listing && listing.title) || "A stay that was removed",
      savedAt: row.createdAt,
      card: available ? toCardItem(listing) : null,
    };
  });
  return {
    items,
    availableCount: items.filter((i) => i.available).length,
    limit: LIMITS.maxItems,
  };
}

module.exports = {
  setSaved,
  savedIdsFor,
  overview,
  ensureDefaultList,
  isPublic,
};
