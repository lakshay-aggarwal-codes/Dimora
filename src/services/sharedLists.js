// Read-only sharing of a wishlist by a link (P10-T04).
//
//   enableShare(userId, listId)  the owner makes the link (idempotent: the same
//                                link until they stop sharing)
//   revokeShare(userId, listId)  the owner stops sharing; the link dies at once
//   viewShared(token)            what a visitor with the link may see
//
// What a visitor sees: the list's name, the owner's display name and the
// stays that are still public, as ordinary cards. Never: the owner's email,
// username, id or profile link, the member's notes, when things were saved,
// stays that were hidden or removed, or any other list. Opening the page
// changes nothing. An unknown, malformed, revoked or orphaned token, and a list
// whose owner is no longer an active member, are the same 404.
const crypto = require("node:crypto");
const { LIMITS } = require("../config/wishlists");
const { toCardItem } = require("../utils/listingCard");
const { NotFoundError } = require("../utils/errors");

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function models(deps = {}) {
  return {
    Wishlist: deps.Wishlist || require("../models/wishlist"),
    WishlistItem: deps.WishlistItem || require("../models/wishlistItem"),
    Listing: deps.Listing || require("../models/listing"),
    User: deps.User || require("../models/user"),
    newToken: deps.newToken || (() => crypto.randomBytes(24).toString("base64url")),
    now: deps.now || (() => new Date()),
  };
}

const isPublic = (listing) =>
  Boolean(listing) && listing.status === "published" && !listing.deletedAt;

async function ownedList(userId, listId, Wishlist) {
  const list = OBJECT_ID.test(String(listId))
    ? await Wishlist.findOne({ _id: listId, owner: userId }).lean()
    : null;
  if (!list) throw new NotFoundError("That list does not exist.");
  return list;
}

/** @returns {Promise<{ token: string, created: boolean }>} */
async function enableShare(userId, listId, deps) {
  const { Wishlist, newToken, now } = models(deps);
  const list = await ownedList(userId, listId, Wishlist);
  if (list.shareToken) return { token: list.shareToken, created: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = newToken();
    try {
      // Only when nobody made a link meanwhile: a twin request gets the same one.
      const result = await Wishlist.updateOne(
        { _id: list._id, owner: userId, shareToken: { $exists: false } },
        { $set: { shareToken: token, sharedAt: now() } },
      );
      const matched = result.matchedCount !== undefined ? result.matchedCount : result.n;
      if (matched) return { token, created: true };
      const again = await Wishlist.findOne({ _id: list._id, owner: userId }).lean();
      if (again && again.shareToken) return { token: again.shareToken, created: false };
    } catch (err) {
      if (!(err && err.code === 11000)) throw err; // the token clashed (astronomically unlikely): try another
    }
  }
  throw new Error("Could not make a share link.");
}

/** @returns {Promise<{ revoked: boolean }>} */
async function revokeShare(userId, listId, deps) {
  const { Wishlist } = models(deps);
  const list = await ownedList(userId, listId, Wishlist);
  await Wishlist.updateOne(
    { _id: list._id, owner: userId },
    { $unset: { shareToken: 1, sharedAt: 1 } },
  );
  return { revoked: Boolean(list.shareToken) };
}

/**
 * @returns {Promise<{ name: string, ownerName: string, items: object[], hidden: number }>}
 * @throws NotFoundError
 */
async function viewShared(token, deps) {
  const { Wishlist, WishlistItem, Listing, User } = models(deps);
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new NotFoundError("That shared list does not exist.");
  }
  const list = await Wishlist.findOne({ shareToken: token }).lean();
  const owner = list
    ? await User.findById(list.owner).select("displayName username status").lean()
    : null;
  if (!list || !owner || owner.status !== "active") {
    throw new NotFoundError("That shared list does not exist.");
  }
  const rows = await WishlistItem.find({ wishlist: list._id })
    .sort({ createdAt: -1 })
    .limit(LIMITS.maxItems)
    .lean();
  const listings = rows.length
    ? await Listing.find({ _id: { $in: rows.map((r) => r.listing) } })
        .select("title image location country pricing status deletedAt")
        .lean()
    : [];
  const byId = new Map(listings.map((l) => [String(l._id), l]));
  const items = rows
    .map((row) => byId.get(String(row.listing)))
    .filter(isPublic)
    .map(toCardItem);
  return {
    name: list.name,
    ownerName: owner.displayName || owner.username,
    items,
    hidden: rows.length - items.length,
  };
}

module.exports = { enableShare, revokeShare, viewShared, TOKEN_PATTERN };
