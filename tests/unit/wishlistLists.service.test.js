// P10-T02: named lists, moving stays, notes (in-memory fakes, no database).
const lists = require("../../src/services/wishlistLists");
const wishlists = require("../../src/services/wishlists");
const { LIMITS } = require("../../src/config/wishlists");
const { FakeCollection, newId } = require("../helpers/fakeCollection");

function world() {
  const Wishlist = new FakeCollection({
    unique: [["owner", "name"], ["owner", "isDefault"]],
    partial: { "owner+isDefault": (d) => d.isDefault === true },
  });
  const WishlistItem = new FakeCollection({ unique: [["wishlist", "listing"]] });
  const deps = { Wishlist, WishlistItem };
  const me = newId();
  const other = newId();
  const mkList = async (owner, name, isDefault = false) => Wishlist.create({ owner, name, isDefault });
  const mkItem = async (list, listing = newId(), extra = {}) =>
    WishlistItem.create({ wishlist: list._id, owner: list.owner, listing, ...extra });
  return { Wishlist, WishlistItem, deps, me, other, mkList, mkItem };
}

describe("names and notes", () => {
  test("a name is one trimmed line of 1 to 60 characters", () => {
    expect(lists.parseName("  Goa   in\tDecember ")).toBe("Goa in December");
    for (const bad of ["", "   ", undefined, 5, "x".repeat(61), "a\u0000b"]) {
      expect(() => lists.parseName(bad)).toThrow();
    }
    expect(lists.parseName("x".repeat(60))).toHaveLength(60);
  });

  test("a note is plain text up to 300 characters; blank removes it", () => {
    expect(lists.parseNote("  Near the beach\nquiet ")).toBe("Near the beach\nquiet");
    expect(lists.parseNote("")).toBe("");
    expect(lists.parseNote(undefined)).toBe("");
    expect(() => lists.parseNote("x".repeat(301))).toThrow();
    expect(() => lists.parseNote(["a"])).toThrow();
    expect(() => lists.parseNote("a\u0000b")).toThrow();
  });
});

describe("createList / renameList", () => {
  test("creates a list for the member; a second with the same name is a 409", async () => {
    const w = world();
    const made = await lists.createList(w.me, " Weekend ", w.deps);
    expect(made.name).toBe("Weekend");
    expect(w.Wishlist.docs[0].isDefault).toBe(false);
    await expect(lists.createList(w.me, "Weekend", w.deps)).rejects.toMatchObject({ statusCode: 409, code: "name_taken" });
    // another member may use the same name
    await expect(lists.createList(w.other, "Weekend", w.deps)).resolves.toMatchObject({ name: "Weekend" });
  });

  test("at most 20 lists", async () => {
    const w = world();
    for (let i = 0; i < LIMITS.maxLists; i += 1) await lists.createList(w.me, `List ${i}`, w.deps);
    await expect(lists.createList(w.me, "One more", w.deps)).rejects.toMatchObject({ statusCode: 409, code: "too_many_lists" });
  });

  test("renaming: own list only, name rules and uniqueness apply", async () => {
    const w = world();
    const a = await lists.createList(w.me, "A", w.deps);
    await lists.createList(w.me, "B", w.deps);
    await expect(lists.renameList(w.me, a.id, "C", w.deps)).resolves.toEqual({ id: a.id, name: "C" });
    await expect(lists.renameList(w.me, a.id, "B", w.deps)).rejects.toMatchObject({ code: "name_taken" });
    await expect(lists.renameList(w.me, a.id, " ", w.deps)).rejects.toMatchObject({ statusCode: 400 });
    await expect(lists.renameList(w.other, a.id, "Mine", w.deps)).rejects.toMatchObject({ statusCode: 404 });
    await expect(lists.renameList(w.me, "nope", "Mine", w.deps)).rejects.toMatchObject({ statusCode: 404 });
    expect(w.Wishlist.docs.find((d) => String(d._id) === a.id).name).toBe("C");
  });
});

describe("deleteList", () => {
  test("its stays move to the main list (a stay already there is not repeated; notes travel)", async () => {
    const w = world();
    const main = await w.mkList(w.me, "Saved", true);
    const trip = await w.mkList(w.me, "Trip");
    const shared = newId();
    await w.mkItem(main, shared);
    await w.mkItem(trip, shared);
    const mine = await w.mkItem(trip, newId(), { note: "quiet street" });
    const result = await lists.deleteList(w.me, trip._id, w.deps);
    expect(result).toEqual({ moved: 1 });
    expect(w.Wishlist.docs).toHaveLength(1);
    const inMain = w.WishlistItem.docs.filter((d) => String(d.wishlist) === String(main._id));
    expect(inMain).toHaveLength(2);
    expect(inMain.find((d) => String(d.listing) === String(mine.listing)).note).toBe("quiet street");
    expect(w.WishlistItem.docs.every((d) => String(d.wishlist) === String(main._id))).toBe(true);
  });

  test("the main list cannot be deleted; someone else's list is a 404", async () => {
    const w = world();
    const main = await w.mkList(w.me, "Saved", true);
    const theirs = await w.mkList(w.other, "Theirs");
    await expect(lists.deleteList(w.me, main._id, w.deps)).rejects.toMatchObject({ statusCode: 409, code: "default_list" });
    await expect(lists.deleteList(w.me, theirs._id, w.deps)).rejects.toMatchObject({ statusCode: 404 });
    expect(w.Wishlist.docs).toHaveLength(2);
  });

  test("if the main list could not hold them, nothing is deleted", async () => {
    const w = world();
    const main = await w.mkList(w.me, "Saved", true);
    const trip = await w.mkList(w.me, "Trip");
    for (let i = 0; i < LIMITS.maxItems; i += 1) await w.mkItem(main);
    await w.mkItem(trip);
    await expect(lists.deleteList(w.me, trip._id, w.deps)).rejects.toMatchObject({ statusCode: 409, code: "target_full" });
    expect(w.Wishlist.docs).toHaveLength(2);
    expect(w.WishlistItem.docs.filter((d) => String(d.wishlist) === String(trip._id))).toHaveLength(1);
  });

  test("a member without a main list yet gets one when the stays need it", async () => {
    const w = world();
    const trip = await w.mkList(w.me, "Trip");
    await w.mkItem(trip);
    await expect(lists.deleteList(w.me, trip._id, w.deps)).resolves.toEqual({ moved: 1 });
    expect(w.Wishlist.docs.filter((d) => d.isDefault)).toHaveLength(1);
  });
});

describe("moveItem", () => {
  test("moves a stay and keeps its note; the stay is then only in the target", async () => {
    const w = world();
    const a = await w.mkList(w.me, "A");
    const b = await w.mkList(w.me, "B");
    const item = await w.mkItem(a, newId(), { note: "n" });
    await expect(lists.moveItem(w.me, { from: a._id, to: b._id, listingId: item.listing }, w.deps)).resolves.toEqual({ moved: true });
    expect(w.WishlistItem.docs).toHaveLength(1);
    expect(String(w.WishlistItem.docs[0].wishlist)).toBe(String(b._id));
    expect(w.WishlistItem.docs[0].note).toBe("n");
  });

  test("if the target has it already, it is only taken out of the source", async () => {
    const w = world();
    const a = await w.mkList(w.me, "A");
    const b = await w.mkList(w.me, "B");
    const listing = newId();
    await w.mkItem(a, listing);
    await w.mkItem(b, listing);
    await lists.moveItem(w.me, { from: a._id, to: b._id, listingId: listing }, w.deps);
    expect(w.WishlistItem.docs).toHaveLength(1);
    expect(String(w.WishlistItem.docs[0].wishlist)).toBe(String(b._id));
  });

  test("same list is a 400; a stay not in the source, a foreign list or bad ids are 404; a full target is a 409", async () => {
    const w = world();
    const a = await w.mkList(w.me, "A");
    const b = await w.mkList(w.me, "B");
    const theirs = await w.mkList(w.other, "T");
    const item = await w.mkItem(a);
    const mv = (over) => lists.moveItem(w.me, { from: a._id, to: b._id, listingId: item.listing, ...over }, w.deps);
    await expect(mv({ to: a._id })).rejects.toMatchObject({ statusCode: 400 });
    await expect(mv({ listingId: newId() })).rejects.toMatchObject({ statusCode: 404 });
    await expect(mv({ to: theirs._id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(mv({ from: theirs._id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(mv({ listingId: "x" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(mv({ to: undefined })).rejects.toMatchObject({ statusCode: 404 });
    for (let i = 0; i < LIMITS.maxItems; i += 1) await w.mkItem(b);
    await expect(mv({})).rejects.toMatchObject({ statusCode: 409, code: "target_full" });
    expect(String(w.WishlistItem.docs.find((d) => String(d.listing) === String(item.listing)).wishlist)).toBe(String(a._id));
  });
});

describe("setNote", () => {
  test("sets, replaces and (blank) removes a note, only in the member's own list", async () => {
    const w = world();
    const a = await w.mkList(w.me, "A");
    const theirs = await w.mkList(w.other, "T");
    const item = await w.mkItem(a);
    const set = (note, over = {}) => lists.setNote(w.me, { listId: a._id, listingId: item.listing, note, ...over }, w.deps);
    await expect(set(" Near the sea ")).resolves.toEqual({ note: "Near the sea" });
    expect(w.WishlistItem.docs[0].note).toBe("Near the sea");
    await set("Changed");
    expect(w.WishlistItem.docs[0].note).toBe("Changed");
    await expect(set("  ")).resolves.toEqual({ note: "" });
    expect(w.WishlistItem.docs[0].note).toBeUndefined();
    await expect(set("x".repeat(301))).rejects.toMatchObject({ statusCode: 400 });
    await expect(set("hi", { listId: theirs._id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(set("hi", { listingId: newId() })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("listsFor and overview with a list", () => {
  test("lists come with counts, the main list first; overview can show one list", async () => {
    const w = world();
    const trip = await w.mkList(w.me, "Trip");
    const main = await w.mkList(w.me, "Saved", true);
    await w.mkList(w.other, "Not mine");
    const shared = newId();
    await w.mkItem(main, shared);
    await w.mkItem(trip, shared, { note: "hello" });
    await w.mkItem(trip);
    const got = await wishlists.listsFor(w.me, w.deps);
    expect(got.map((l) => [l.name, l.isDefault, l.count])).toEqual([["Saved", true, 1], ["Trip", false, 2]]);
    expect(await wishlists.listsFor(newId(), w.deps)).toEqual([]);
  });
});
