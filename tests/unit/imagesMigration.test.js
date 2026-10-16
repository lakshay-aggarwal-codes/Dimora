// Migration 004 (listing photos v2) without a database.
const { readOnlyDb } = require("../../scripts/migrate");
const {
  up,
  down,
  upgradeImage,
  planImageMigration,
} = require("../../scripts/migrations/004-listing-images-v2");

let counter = 0;
const makeId = () => `id${(counter += 1)}`;
beforeEach(() => {
  counter = 0;
});

describe("upgradeImage", () => {
  test("filename becomes publicId; _id, alt and order are added", () => {
    expect(
      upgradeImage(
        { url: "u", filename: "dimora_DEV/a", caption: "c", order: 0 },
        0,
        makeId,
      ),
    ).toEqual({
      url: "u",
      publicId: "dimora_DEV/a",
      caption: "c",
      alt: "",
      order: 0,
      _id: "id1",
    });
  });
  test("an empty filename gives an empty publicId", () => {
    expect(
      upgradeImage({ url: "u", filename: "", order: 0 }, 0, makeId).publicId,
    ).toBe("");
  });
  test("a finished photo comes back as the same object (no change)", () => {
    const done = {
      _id: "x",
      url: "u",
      publicId: "p",
      alt: "",
      caption: "",
      order: 0,
    };
    expect(upgradeImage(done, 0, makeId)).toBe(done);
  });
  test("an existing publicId wins over a leftover filename, which is dropped", () => {
    const next = upgradeImage(
      {
        _id: "x",
        url: "u",
        publicId: "new",
        filename: "old",
        alt: "",
        order: 0,
      },
      0,
      makeId,
    );
    expect(next.publicId).toBe("new");
    expect(next).not.toHaveProperty("filename");
  });
  test("order is corrected to the position", () => {
    expect(
      upgradeImage(
        { _id: "x", url: "u", publicId: "p", alt: "", order: 5 },
        2,
        makeId,
      ).order,
    ).toBe(2);
  });
  test("junk entries are not touched", () => {
    expect(upgradeImage(null, 0, makeId)).toBeNull();
    expect(upgradeImage("x", 0, makeId)).toBeNull();
  });
});

describe("planImageMigration", () => {
  const old = (id) => ({
    _id: id,
    images: [
      { url: "u1", filename: "f1", caption: "", order: 0 },
      { url: "u2", filename: "f2", caption: "", order: 1 },
    ],
  });

  test("plans an update only for listings that need one", () => {
    const done = {
      _id: "d",
      images: [
        { _id: "x", url: "u", publicId: "p", alt: "", caption: "", order: 0 },
      ],
    };
    const plan = planImageMigration(
      [old("a"), { _id: "b", images: [] }, { _id: "c" }, done],
      makeId,
    );
    expect(plan.counts).toEqual({
      scanned: 4,
      listingsToUpdate: 1,
      photosUpgraded: 2,
    });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]._id).toBe("a");
    expect(plan.updates[0].images.map((i) => i.publicId)).toEqual(["f1", "f2"]);
    expect(plan.updates[0].images.map((i) => i._id)).toEqual(["id1", "id2"]);
  });

  test("the stored display order is kept (sorted by order, ties by position)", () => {
    const doc = {
      _id: "a",
      images: [
        { url: "second", filename: "f2", order: 1 },
        { url: "first", filename: "f1", order: 0 },
      ],
    };
    const { updates } = planImageMigration([doc], makeId);
    expect(updates[0].images.map((i) => i.url)).toEqual(["first", "second"]);
    expect(updates[0].images.map((i) => i.order)).toEqual([0, 1]);
  });

  test("running the plan's result through the planner again changes nothing", () => {
    const first = planImageMigration([old("a")], makeId);
    const second = planImageMigration(
      [{ _id: "a", images: first.updates[0].images }],
      makeId,
    );
    expect(second.updates).toEqual([]);
    expect(second.counts.photosUpgraded).toBe(0);
  });
});

class FakeListings {
  constructor(docs) {
    this.docs = docs;
    this.writes = 0;
  }
  find() {
    return {
      toArray: async () =>
        this.docs
          .filter((d) => Array.isArray(d.images) && d.images.length)
          .map((d) => ({ ...d })),
    };
  }
  async bulkWrite(ops) {
    for (const { updateOne } of ops) {
      this.writes += 1;
      Object.assign(
        this.docs.find((d) => d._id === updateOne.filter._id),
        updateOne.update.$set,
      );
    }
  }
  async updateOne(filter, update) {
    Object.assign(
      this.docs.find((d) => d._id === filter._id),
      update.$set,
    );
  }
}
const fakeDb = (docs) => {
  const listings = new FakeListings(docs);
  return {
    listings,
    db: { collection: (name) => (name === "listings" ? listings : null) },
  };
};

describe("up / down", () => {
  const docs = () => [
    { _id: "a", images: [{ url: "u1", filename: "f1", order: 0 }] },
    { _id: "b", images: [] },
  ];

  test("up upgrades the photos and a second run writes nothing", async () => {
    const { db, listings } = fakeDb(docs());
    const result = await up(db, { log() {} });
    expect(result).toEqual({
      scanned: 1,
      listingsToUpdate: 1,
      photosUpgraded: 1,
    });
    const photo = listings.docs[0].images[0];
    expect(photo.publicId).toBe("f1");
    expect(photo).not.toHaveProperty("filename");
    expect(photo._id).toBeDefined();
    const before = listings.writes;
    const again = await up(db, {});
    expect(again.listingsToUpdate).toBe(0);
    expect(listings.writes).toBe(before);
  });

  test("a dry run counts and writes nothing", async () => {
    const { db, listings } = fakeDb(docs());
    const result = await up(readOnlyDb(db), { dryRun: true });
    expect(result.photosUpgraded).toBe(1);
    expect(listings.writes).toBe(0);
    expect(listings.docs[0].images[0].filename).toBe("f1");
  });

  test("down puts filename back", async () => {
    const { db, listings } = fakeDb(docs());
    await up(db, {});
    await down(db);
    expect(listings.docs[0].images[0].filename).toBe("f1");
    expect(listings.docs[0].images[0]).not.toHaveProperty("publicId");
  });
});
