// P10-T01: the saving rules, against in-memory fakes of the four models (no
// database). The fakes copy what the real unique indexes and upserts do.
const { ObjectId } = require("mongoose").Types;
const service = require("../../src/services/wishlists");
const { LIMITS } = require("../../src/config/wishlists");

const query = (rows) => {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    lean: async () => rows,
  };
  return q;
};
const one = (row) => ({ lean: async () => row ?? null });

function fakes({ listings = [] } = {}) {
  const lists = [];
  const items = [];
  const stat = new Map();
  const same = (a, b) => String(a) === String(b);
  const deps = {
    now: () => new Date("2026-10-25T00:00:00Z"),
    Listing: {
      findById: (id) => ({
        select: () => one(listings.find((l) => same(l._id, id))),
      }),
      find: (filter) =>
        query(
          listings.filter((l) => filter._id.$in.some((id) => same(id, l._id))),
        ),
    },
    Wishlist: {
      findOne: (f) => one(lists.find((l) => same(l.owner, f.owner) && l.isDefault)),
      findOneAndUpdate: (f, update) => {
        let list = lists.find((l) => same(l.owner, f.owner) && l.isDefault);
        if (!list) {
          list = { _id: new ObjectId(), ...update.$setOnInsert };
          lists.push(list);
        }
        return one(list);
      },
    },
    WishlistItem: {
      findOne: (f) =>
        one(items.find((i) => same(i.wishlist, f.wishlist) && same(i.listing, f.listing))),
      countDocuments: async (f) => items.filter((i) => same(i.wishlist, f.wishlist)).length,
      updateOne: async (f, update) => {
        const exists = items.some((i) => same(i.wishlist, f.wishlist) && same(i.listing, f.listing));
        if (exists) return { upsertedCount: 0 };
        items.push({ ...update.$setOnInsert });
        return { upsertedCount: 1 };
      },
      deleteMany: async (f) => {
        const before = items.length;
        for (let i = items.length - 1; i >= 0; i--) {
          if (same(items[i].owner, f.owner) && same(items[i].listing, f.listing)) items.splice(i, 1);
        }
        return { deletedCount: before - items.length };
      },
      find: (f) => query(items.filter((i) => same(i.owner, f.owner)).sort((a, b) => b.createdAt - a.createdAt)),
    },
    ListingStat: {
      updateOne: async (f, update) => {
        stat.set(String(f.listing), (stat.get(String(f.listing)) || 0) + update.$inc.saves);
      },
    },
    // P13-T03: the real ones write to the database; the clamp is tested with the stats service.
    stats: {
      recordSave: async () => {},
      clampSaves: async (id) => {
        if ((stat.get(String(id)) || 0) < 0) stat.set(String(id), 0);
      },
    },
  };
  return { deps, items, lists, stat };
}

const published = () => ({ _id: new ObjectId(), title: "Sea house", status: "published", pricing: { nightlyMinor: 500000 } });
const fails = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
};

describe("setSaved", () => {
  test("saving twice keeps one row and counts one save", async () => {
    const listing = published();
    const { deps, items, stat } = fakes({ listings: [listing] });
    const user = new ObjectId();
    expect(await service.setSaved(user, listing._id, true, deps)).toEqual({ saved: true, changed: true });
    expect(await service.setSaved(user, listing._id, true, deps)).toEqual({ saved: true, changed: false });
    expect(items.length).toBe(1);
    expect(stat.get(String(listing._id))).toBe(1);
  });

  test("removing twice removes once and counts one", async () => {
    const listing = published();
    const { deps, items, stat } = fakes({ listings: [listing] });
    const user = new ObjectId();
    await service.setSaved(user, listing._id, true, deps);
    expect(await service.setSaved(user, listing._id, false, deps)).toEqual({ saved: false, changed: true });
    expect(await service.setSaved(user, listing._id, false, deps)).toEqual({ saved: false, changed: false });
    expect(items.length).toBe(0);
    expect(stat.get(String(listing._id))).toBe(0);
  });

  test("one member's save does not touch another's", async () => {
    const listing = published();
    const { deps, items } = fakes({ listings: [listing] });
    const [a, b] = [new ObjectId(), new ObjectId()];
    await service.setSaved(a, listing._id, true, deps);
    await service.setSaved(b, listing._id, true, deps);
    await service.setSaved(a, listing._id, false, deps);
    expect(items.length).toBe(1);
    expect(String(items[0].owner)).toBe(String(b));
  });

  test("a stay that is not public cannot be saved (404), but can be removed", async () => {
    const draft = { ...published(), status: "draft" };
    const gone = { ...published(), deletedAt: new Date() };
    const { deps } = fakes({ listings: [draft, gone] });
    const user = new ObjectId();
    expect((await fails(service.setSaved(user, draft._id, true, deps))).statusCode).toBe(404);
    expect((await fails(service.setSaved(user, gone._id, true, deps))).statusCode).toBe(404);
    expect((await fails(service.setSaved(user, new ObjectId(), true, deps))).statusCode).toBe(404);
    expect((await fails(service.setSaved(user, "not-an-id", true, deps))).statusCode).toBe(404);
    expect(await service.setSaved(user, gone._id, false, deps)).toEqual({ saved: false, changed: false });
  });

  test("the list is full at the limit (409), but a stay already saved is not refused", async () => {
    const all = Array.from({ length: LIMITS.maxItems + 1 }, published);
    const { deps, items } = fakes({ listings: all });
    const user = new ObjectId();
    for (const l of all.slice(0, LIMITS.maxItems)) await service.setSaved(user, l._id, true, deps);
    expect(items.length).toBe(LIMITS.maxItems);
    const err = await fails(service.setSaved(user, all[LIMITS.maxItems]._id, true, deps));
    expect(err.statusCode).toBe(409);
    expect(await service.setSaved(user, all[0]._id, true, deps)).toEqual({ saved: true, changed: false });
  });

  test("the wanted state must be a real boolean", async () => {
    const { deps } = fakes();
    expect((await fails(service.setSaved(new ObjectId(), new ObjectId(), "yes", deps))).statusCode).toBe(400);
  });
});

describe("savedIdsFor and overview", () => {
  test("only this member's ids; signed out gives an empty set", async () => {
    const [x, y] = [published(), published()];
    const { deps } = fakes({ listings: [x, y] });
    const [a, b] = [new ObjectId(), new ObjectId()];
    await service.setSaved(a, x._id, true, deps);
    await service.setSaved(b, y._id, true, deps);
    expect([...(await service.savedIdsFor(a, deps))]).toEqual([String(x._id)]);
    expect((await service.savedIdsFor(undefined, deps)).size).toBe(0);
  });

  test("a stay that stopped being public stays in the list as unavailable", async () => {
    const [x, y] = [published(), published()];
    const { deps } = fakes({ listings: [x, y] });
    const user = new ObjectId();
    await service.setSaved(user, x._id, true, deps);
    await service.setSaved(user, y._id, true, deps);
    y.status = "suspended"; // the host hides it later
    const { items, availableCount } = await service.overview(user, deps);
    expect(items.length).toBe(2);
    expect(availableCount).toBe(1);
    const hidden = items.find((i) => i.id === String(y._id));
    expect(hidden.available).toBe(false);
    expect(hidden.card).toBe(null);
    expect(hidden.title).toBe("Sea house");
  });

  test("a hard-deleted stay is still listed, with a plain title", async () => {
    const x = published();
    const f = fakes({ listings: [x] });
    const user = new ObjectId();
    await service.setSaved(user, x._id, true, f.deps);
    f.deps.Listing.find = () => query([]); // the document is gone
    const { items } = await service.overview(user, f.deps);
    expect(items[0].available).toBe(false);
    expect(items[0].title).toBe("A stay that was removed");
  });
});
