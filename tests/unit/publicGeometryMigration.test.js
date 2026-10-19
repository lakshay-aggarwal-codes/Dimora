// Migration 007 (public geometry and its index), no database.
const migration = require("../../scripts/migrations/007-listing-public-geometry");
const geo = require("../../src/utils/geo");

geo.configureLocationSecret("migration-test-secret-0123456789");
const DELHI = { type: "Point", coordinates: [77.20931, 28.61391] };

const wantedFor = (id, geometry = DELHI) => geo.approximatePoint(geometry, id);

describe("planPublicGeometry", () => {
  test("a listing with a precise point and no public point gets one", () => {
    const { updates, counts } = migration.planPublicGeometry([{ _id: "a1", geometry: DELHI }], geo);
    expect(updates).toEqual([{ _id: "a1", set: { publicGeometry: wantedFor("a1") } }]);
    expect(counts).toEqual({ scanned: 1, toSet: 1, toUnset: 0 });
  });

  test("one that already has the right public point is left alone", () => {
    const { updates } = migration.planPublicGeometry([{ _id: "a1", geometry: DELHI, publicGeometry: wantedFor("a1") }], geo);
    expect(updates).toEqual([]);
  });

  test("a wrong or stale public point (the address moved, or the secret changed) is replaced", () => {
    const stale = { type: "Point", coordinates: [1, 2] };
    const { updates } = migration.planPublicGeometry([{ _id: "a1", geometry: DELHI, publicGeometry: stale }], geo);
    expect(updates).toHaveLength(1);
    expect(updates[0].set.publicGeometry).toEqual(wantedFor("a1"));
  });

  test("no usable precise point: any public point is removed, and nothing is invented", () => {
    const { updates, counts } = migration.planPublicGeometry(
      [
        { _id: "b1", geometry: { type: "Point", coordinates: [] }, publicGeometry: wantedFor("b1") },
        { _id: "b2" },
        { _id: "b3", geometry: null, publicGeometry: null },
      ],
      geo,
    );
    expect(updates).toEqual([{ _id: "b1", unset: { publicGeometry: "" } }]);
    expect(counts).toEqual({ scanned: 3, toSet: 0, toUnset: 1 });
  });

  test("the public point is never the precise point", () => {
    const { updates } = migration.planPublicGeometry([{ _id: "a1", geometry: DELHI }], geo);
    expect(updates[0].set.publicGeometry.coordinates).not.toEqual(DELHI.coordinates);
  });
});

function fakeDb(docs) {
  const calls = { indexes: [], dropped: [], unset: 0 };
  const collection = {
    find: () => ({ toArray: async () => docs.map((d) => ({ ...d })) }),
    async bulkWrite(ops) {
      for (const { updateOne } of ops) {
        const doc = docs.find((d) => d._id === updateOne.filter._id);
        if (updateOne.update.$set) Object.assign(doc, updateOne.update.$set);
        if (updateOne.update.$unset) for (const k of Object.keys(updateOne.update.$unset)) delete doc[k];
      }
      return { modifiedCount: ops.length };
    },
    async createIndex(spec, options) { calls.indexes.push([spec, options.name]); },
    async dropIndex(name) { calls.dropped.push(name); },
    async updateMany() { calls.unset += 1; },
  };
  return { calls, collection: () => collection };
}

describe("up / down", () => {
  const withSecret = async (fn) => {
    const before = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "migration-test-secret-0123456789";
    try { return await fn(); } finally { if (before === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = before; }
  };

  test("fills the public points, builds the 2dsphere index, and a second run changes nothing", async () => {
    await withSecret(async () => {
      const docs = [{ _id: "a1", geometry: DELHI }, { _id: "a2" }];
      const db = fakeDb(docs);
      expect(await migration.up(db, {})).toEqual({ scanned: 2, updated: 1, indexes: 1 });
      expect(docs[0].publicGeometry).toEqual(wantedFor("a1"));
      expect(docs[1].publicGeometry).toBeUndefined();
      expect(db.calls.indexes).toEqual([[{ publicGeometry: "2dsphere" }, "publicGeometry_2dsphere"]]);
      expect((await migration.up(db, {})).updated).toBe(0);
    });
  });

  test("a dry run counts and writes nothing", async () => {
    await withSecret(async () => {
      const docs = [{ _id: "a1", geometry: DELHI }];
      const db = fakeDb(docs);
      expect(await migration.up(db, { dryRun: true })).toEqual({ scanned: 1, toSet: 1, toUnset: 0, indexes: 1 });
      expect(docs[0].publicGeometry).toBeUndefined();
      expect(db.calls.indexes).toEqual([]);
    });
  });

  test("without SESSION_SECRET it refuses to run rather than use a key anyone can read", async () => {
    const before = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      await migration.up(fakeDb([]), {}).then(() => { throw new Error("should have failed"); }, (err) => expect(err).toBeInstanceOf(TypeError));
    } finally {
      if (before !== undefined) process.env.SESSION_SECRET = before;
    }
  });

  test("down drops the index and the public points", async () => {
    const db = fakeDb([]);
    expect(await migration.down(db, {})).toEqual({ indexesDropped: 1 });
    expect(db.calls.dropped).toEqual(["publicGeometry_2dsphere"]);
    expect(db.calls.unset).toBe(1);
  });
});
