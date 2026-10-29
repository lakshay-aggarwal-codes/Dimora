// P10-T04: read-only share links for a wishlist (in-memory fakes, no database).
const shared = require("../../src/services/sharedLists");
const { FakeCollection, newId } = require("../helpers/fakeCollection");

function world() {
  const Wishlist = new FakeCollection({ unique: [["owner", "name"]] });
  const WishlistItem = new FakeCollection({ unique: [["wishlist", "listing"]] });
  const listings = new Map();
  const users = new Map();
  const Listing = {
    find: ({ _id }) => ({ select: () => ({ lean: async () => _id.$in.map((id) => listings.get(String(id))).filter(Boolean) }) }),
  };
  const User = { findById: (id) => ({ select: () => ({ lean: async () => users.get(String(id)) || null }) }) };
  let n = 0;
  const deps = { Wishlist, WishlistItem, Listing, User, newToken: () => `tok${String((n += 1)).padStart(29, "0")}` };
  const me = newId();
  users.set(String(me), { _id: me, username: "ravi", displayName: "Ravi", status: "active", email: "ravi@example.com" });
  const mkList = (owner = me, name = "Goa") => Wishlist.create({ owner, name, isDefault: false });
  const mkStay = (over = {}) => {
    const l = { _id: newId(), title: "Sea house", image: { url: "https://img/x.jpg" }, location: "Goa", country: "India", pricing: { nightlyMinor: 500000, currency: "INR" }, status: "published", deletedAt: null, ...over };
    listings.set(String(l._id), l);
    return l;
  };
  const put = (list, stay, extra = {}) => WishlistItem.create({ wishlist: list._id, owner: list.owner, listing: stay._id, ...extra });
  return { Wishlist, WishlistItem, deps, me, users, mkList, mkStay, put };
}

describe("enableShare / revokeShare", () => {
  test("makes one unguessable link; asking again gives the same one", async () => {
    const w = world();
    const list = await w.mkList();
    const first = await shared.enableShare(w.me, list._id, w.deps);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(shared.TOKEN_PATTERN);
    const again = await shared.enableShare(w.me, list._id, w.deps);
    expect(again).toEqual({ token: first.token, created: false });
    expect(w.Wishlist.docs[0].shareToken).toBe(first.token);
  });

  test("real tokens are 32 URL-safe characters from random bytes, all different", async () => {
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) {
      const w = world();
      const list = await w.mkList();
      const { token } = await shared.enableShare(w.me, list._id, { ...w.deps, newToken: undefined });
      expect(token).toMatch(shared.TOKEN_PATTERN);
      seen.add(token);
    }
    expect(seen.size).toBe(50);
  });

  test("only the owner: someone else's list or a bad id is a 404", async () => {
    const w = world();
    const list = await w.mkList();
    const other = newId();
    await expect(shared.enableShare(other, list._id, w.deps)).rejects.toMatchObject({ statusCode: 404 });
    await expect(shared.revokeShare(other, list._id, w.deps)).rejects.toMatchObject({ statusCode: 404 });
    await expect(shared.enableShare(w.me, "nope", w.deps)).rejects.toMatchObject({ statusCode: 404 });
    expect(w.Wishlist.docs[0].shareToken).toBeUndefined();
  });

  test("revoking kills the link at once; sharing again makes a different one", async () => {
    const w = world();
    const list = await w.mkList();
    const { token } = await shared.enableShare(w.me, list._id, w.deps);
    await expect(shared.revokeShare(w.me, list._id, w.deps)).resolves.toEqual({ revoked: true });
    await expect(shared.viewShared(token, w.deps)).rejects.toMatchObject({ statusCode: 404 });
    await expect(shared.revokeShare(w.me, list._id, w.deps)).resolves.toEqual({ revoked: false });
    const next = await shared.enableShare(w.me, list._id, w.deps);
    expect(next.token).not.toBe(token);
    await expect(shared.viewShared(token, w.deps)).rejects.toMatchObject({ statusCode: 404 });
    await expect(shared.viewShared(next.token, w.deps)).resolves.toBeDefined();
  });
});

describe("viewShared", () => {
  test("the list name, the owner's display name and the public stays as cards, nothing private", async () => {
    const w = world();
    const list = await w.mkList(w.me, "Goa trip");
    const a = w.mkStay({ title: "Sea house" });
    const b = w.mkStay({ title: "Hill cabin" });
    await w.put(list, a, { note: "my secret note" });
    await w.put(list, b);
    const { token } = await shared.enableShare(w.me, list._id, w.deps);
    const view = await shared.viewShared(token, w.deps);
    expect(view.name).toBe("Goa trip");
    expect(view.ownerName).toBe("Ravi");
    expect(view.items.map((i) => i.title).sort()).toEqual(["Hill cabin", "Sea house"]);
    expect(view.hidden).toBe(0);
    const text = JSON.stringify(view);
    for (const secret of ["ravi@example.com", "my secret note", String(w.me), "ravi\""]) expect(text).not.toContain(secret);
  });

  test("hidden, removed and deleted stays are not shown, only counted", async () => {
    const w = world();
    const list = await w.mkList();
    await w.put(list, w.mkStay({ title: "Open" }));
    await w.put(list, w.mkStay({ title: "Draft", status: "draft" }));
    await w.put(list, w.mkStay({ title: "Gone", deletedAt: new Date() }));
    await w.put(list, { _id: newId() }); // the listing document no longer exists
    const { token } = await shared.enableShare(w.me, list._id, w.deps);
    const view = await shared.viewShared(token, w.deps);
    expect(view.items.map((i) => i.title)).toEqual(["Open"]);
    expect(view.hidden).toBe(3);
  });

  test("shows only the stays of THIS list", async () => {
    const w = world();
    const a = await w.mkList(w.me, "A");
    const b = await w.mkList(w.me, "B");
    await w.put(a, w.mkStay({ title: "In A" }));
    await w.put(b, w.mkStay({ title: "In B" }));
    const { token } = await shared.enableShare(w.me, a._id, w.deps);
    expect((await shared.viewShared(token, w.deps)).items.map((i) => i.title)).toEqual(["In A"]);
  });

  test("an unknown or malformed token, an unshared list and an inactive owner are the same 404", async () => {
    const w = world();
    const list = await w.mkList();
    const { token } = await shared.enableShare(w.me, list._id, w.deps);
    for (const bad of ["nope", "", undefined, null, ["a"], { $ne: 1 }, token.slice(0, -1), `${token}x`, "A".repeat(32)]) {
      await expect(shared.viewShared(bad, w.deps)).rejects.toMatchObject({ statusCode: 404 });
    }
    for (const status of ["suspended", "deleted"]) {
      w.users.get(String(w.me)).status = status;
      await expect(shared.viewShared(token, w.deps)).rejects.toMatchObject({ statusCode: 404 });
    }
    w.users.delete(String(w.me));
    await expect(shared.viewShared(token, w.deps)).rejects.toMatchObject({ statusCode: 404 });
  });
});
