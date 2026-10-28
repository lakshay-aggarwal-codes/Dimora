// Named lists, moving stays between them and notes (P10-T02). Every function
// takes the signed-in member's id and only ever touches that member's own
// lists: a list id that is not theirs is a 404, the same as one that does not
// exist.
//
// The heart (setSaved, P10-T01) still saves into the default list; here the
// member organises what is saved. A stay may be in several lists; "saved" for
// ListingStat.saves means "in at least one list" is NOT tracked: the counter
// follows rows as in P10-T01, and moving a stay never changes it.
const { LIMITS, NAME_MAX, NOTE_MAX } = require("../config/wishlists");
const {
  NotFoundError,
  ConflictError,
  ValidationError,
} = require("../utils/errors");
const { ensureDefaultList } = require("./wishlists");

const OBJECT_ID = /^[0-9a-f]{24}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function models(deps = {}) {
  return {
    Wishlist: deps.Wishlist || require("../models/wishlist"),
    WishlistItem: deps.WishlistItem || require("../models/wishlistItem"),
  };
}

const isDuplicate = (err) => Boolean(err) && err.code === 11000;

/** A list name: one line, 1 to 60 characters, no control characters. */
function parseName(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new ValidationError("Give the list a name.");
  if (name.length > NAME_MAX) {
    throw new ValidationError(`A list name can have at most ${NAME_MAX} characters.`);
  }
  if (CONTROL.test(name)) throw new ValidationError("That name has characters that are not allowed.");
  return name;
}

/** A note: plain text up to 300 characters; blank means "remove the note". */
function parseNote(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidationError("A note must be text.");
  const note = value.replace(/\r\n?/g, "\n").trim();
  if (note.length > NOTE_MAX) {
    throw new ValidationError(`A note can have at most ${NOTE_MAX} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(note)) {
    throw new ValidationError("That note has characters that are not allowed.");
  }
  return note;
}

async function ownedList(userId, listId, deps) {
  const { Wishlist } = models(deps);
  const list = OBJECT_ID.test(String(listId))
    ? await Wishlist.findOne({ _id: listId, owner: userId }).lean()
    : null;
  if (!list) throw new NotFoundError("That list does not exist.");
  return list;
}

const duplicateName = () =>
  new ConflictError("You already have a list with that name.", { code: "name_taken" });

/** @returns {Promise<{ id: string, name: string }>} */
async function createList(userId, name, deps) {
  const { Wishlist } = models(deps);
  const clean = parseName(name);
  const count = await Wishlist.countDocuments({ owner: userId });
  if (count >= LIMITS.maxLists) {
    throw new ConflictError(`You can have at most ${LIMITS.maxLists} lists. Delete one to make another.`, {
      code: "too_many_lists",
    });
  }
  try {
    const list = await Wishlist.create({ owner: userId, name: clean, isDefault: false });
    return { id: String(list._id), name: list.name };
  } catch (err) {
    if (isDuplicate(err)) throw duplicateName();
    throw err;
  }
}

async function renameList(userId, listId, name, deps) {
  const { Wishlist } = models(deps);
  const list = await ownedList(userId, listId, deps);
  const clean = parseName(name);
  try {
    await Wishlist.updateOne({ _id: list._id, owner: userId }, { $set: { name: clean } });
  } catch (err) {
    if (isDuplicate(err)) throw duplicateName();
    throw err;
  }
  return { id: String(list._id), name: clean };
}

/**
 * Deletes a list. The stays in it are not lost: they move to the default list
 * (a stay already there is simply not repeated; notes travel with them). The
 * default list itself cannot be deleted. If the default list could not hold
 * them all (100 stays), nothing is deleted.
 * @returns {Promise<{ moved: number }>}
 */
async function deleteList(userId, listId, deps) {
  const { Wishlist, WishlistItem } = models(deps);
  const list = await ownedList(userId, listId, deps);
  if (list.isDefault) {
    throw new ConflictError("Your main list cannot be deleted.", { code: "default_list" });
  }
  const target = await ensureDefaultList(userId, deps);
  const rows = await WishlistItem.find({ wishlist: list._id }).lean();
  const there = new Set(
    (await WishlistItem.find({ wishlist: target._id }).select("listing").lean()).map((r) => String(r.listing)),
  );
  const toMove = rows.filter((row) => !there.has(String(row.listing)));
  if (there.size + toMove.length > LIMITS.maxItems) {
    throw new ConflictError(
      `Your main list would hold more than ${LIMITS.maxItems} stays. Remove some first.`,
      { code: "target_full" },
    );
  }
  for (const row of toMove) {
    try {
      await WishlistItem.updateOne({ _id: row._id }, { $set: { wishlist: target._id } });
    } catch (err) {
      if (!isDuplicate(err)) throw err; // it got there meanwhile: the row below is removed with the list
    }
  }
  await WishlistItem.deleteMany({ wishlist: list._id });
  await Wishlist.deleteOne({ _id: list._id, owner: userId, isDefault: false });
  return { moved: toMove.length };
}

/**
 * Moves one stay from one of the member's lists to another. If the target
 * already has it the stay is only taken out of the source.
 * @returns {Promise<{ moved: boolean }>}
 */
async function moveItem(userId, { from, to, listingId }, deps) {
  const { WishlistItem } = models(deps);
  if (!OBJECT_ID.test(String(listingId))) throw new NotFoundError("That stay is not in this list.");
  const source = await ownedList(userId, from, deps);
  const target = await ownedList(userId, to, deps);
  if (String(source._id) === String(target._id)) {
    throw new ValidationError("Choose a different list to move it to.");
  }
  const row = await WishlistItem.findOne({ wishlist: source._id, listing: listingId, owner: userId }).lean();
  if (!row) throw new NotFoundError("That stay is not in this list.");
  const already = await WishlistItem.findOne({ wishlist: target._id, listing: listingId }).lean();
  if (already) {
    await WishlistItem.deleteOne({ _id: row._id });
    return { moved: true };
  }
  const count = await WishlistItem.countDocuments({ wishlist: target._id });
  if (count >= LIMITS.maxItems) {
    throw new ConflictError(`That list is full (${LIMITS.maxItems} stays).`, { code: "target_full" });
  }
  try {
    await WishlistItem.updateOne({ _id: row._id }, { $set: { wishlist: target._id } });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    await WishlistItem.deleteOne({ _id: row._id }); // a twin request put it there first
  }
  return { moved: true };
}

/** Sets (or, when blank, removes) the member's note on a stay in one of their lists. */
async function setNote(userId, { listId, listingId, note }, deps) {
  const { WishlistItem } = models(deps);
  if (!OBJECT_ID.test(String(listingId))) throw new NotFoundError("That stay is not in this list.");
  const list = await ownedList(userId, listId, deps);
  const clean = parseNote(note);
  const result = await WishlistItem.updateOne(
    { wishlist: list._id, listing: listingId, owner: userId },
    clean ? { $set: { note: clean } } : { $unset: { note: 1 } },
  );
  const matched = result.matchedCount !== undefined ? result.matchedCount : result.n;
  if (!matched) throw new NotFoundError("That stay is not in this list.");
  return { note: clean };
}

module.exports = {
  createList,
  renameList,
  deleteList,
  moveItem,
  setNote,
  parseName,
  parseNote,
};
