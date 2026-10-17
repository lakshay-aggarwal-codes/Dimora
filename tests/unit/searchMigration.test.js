// Migration 006 (search keys and indexes), no database.
const migration = require("../../scripts/migrations/006-listing-search-keys");
const { keysForListing, normaliseToken } = require("../../src/utils/searchKeys");

const SAMPLES = [
  { address: { city: "Panaji", state: "Goa", country: "India" } },
  { address: { city: "Malibu, California" }, country: "United States" },
  { location: "Manali", country: "India" },
  { location: "São Paulo, SP", country: "Brasil" },
  { address: { city: "  Zürich ", country: "Schweiz" } },
  { location: "St. John's", country: "Canada" },
  { address: { city: "Panaji, Goa", state: "GA", country: "India" } },
  { address: { country: "India" } },
  {},
];

test("the frozen copy of the key rules agrees with the app's on every sample", () => {
  for (const sample of SAMPLES) {
    expect(migration.keysFor(sample)).toEqual(keysForListing(sample));
  }
  for (const text of ["São Paulo", "  A  b ", "x".repeat(300), "!!", "Jaipur-Rural"]) {
    expect(migration.normaliseToken(text)).toBe(normaliseToken(text));
  }
});

describe("planSearchKeys", () => {
  test("a listing without keys gets all four", () => {
    const { updates, counts } = migration.planSearchKeys([
      { _id: 1, address: { city: "Panaji", state: "Goa", country: "India" } },
    ]);
    expect(updates).toEqual([
      {
        _id: 1,
        set: {
          cityKey: "panaji",
          stateKey: "goa",
          countryKey: "india",
          locationKey: "panaji|goa|india",
        },
      },
    ]);
    expect(counts).toEqual({ scanned: 1, toUpdate: 1 });
  });

  test("only the keys that are wrong are written; correct listings are left alone", () => {
    const right = { _id: 1, ...migration.keysFor({ location: "Manali", country: "India" }), location: "Manali", country: "India" };
    const stale = { ...right, _id: 2, cityKey: "old" };
    const { updates } = migration.planSearchKeys([right, stale]);
    expect(updates).toEqual([{ _id: 2, set: { cityKey: "manali" } }]);
  });

  test("an old-style listing gets keys from its text fields; an empty one gets empty keys, so it is not rechecked", () => {
    const { updates } = migration.planSearchKeys([{ _id: 1, location: "Manali", country: "India" }, { _id: 2 }]);
    expect(updates).toHaveLength(2);
    expect(updates[0].set.cityKey).toBe("manali");
    expect(updates[1].set).toEqual({ cityKey: "", stateKey: "", countryKey: "", locationKey: "" });
  });
});

function fakeDb(docs) {
  const calls = { writes: 0, indexes: [], dropped: [], unset: 0 };
  const collection = {
    find: () => ({ toArray: async () => docs.map((d) => ({ ...d })) }),
    async bulkWrite(ops) {
      let modifiedCount = 0;
      for (const { updateOne } of ops) {
        const doc = docs.find((d) => d._id === updateOne.filter._id);
        Object.assign(doc, updateOne.update.$set);
        modifiedCount += 1;
        calls.writes += 1;
      }
      return { modifiedCount };
    },
    async createIndex(spec, options) {
      calls.indexes.push(options.name);
    },
    async dropIndex(name) {
      calls.dropped.push(name);
    },
    async updateMany() {
      calls.unset += 1;
    },
  };
  return { calls, collection: () => collection };
}

test("up fills the keys, builds both indexes, and a second run changes nothing", async () => {
  const docs = [
    { _id: 1, address: { city: "Panaji", state: "Goa", country: "India" } },
    { _id: 2, location: "Manali", country: "India" },
  ];
  const db = fakeDb(docs);
  expect(await migration.up(db, {})).toEqual({ scanned: 2, updated: 2, indexes: 2 });
  expect(docs[0].locationKey).toBe("panaji|goa|india");
  expect(docs[1].cityKey).toBe("manali");
  expect(db.calls.indexes).toEqual([
    "status_1_cityKey_1_pricing.nightlyMinor_1",
    "status_1_countryKey_1_pricing.nightlyMinor_1",
  ]);
  expect((await migration.up(db, {})).updated).toBe(0);
});

test("a dry run counts and writes nothing", async () => {
  const db = fakeDb([{ _id: 1, location: "Manali", country: "India" }]);
  expect(await migration.up(db, { dryRun: true })).toEqual({ scanned: 1, toUpdate: 1, indexes: 2 });
  expect(db.calls.writes).toBe(0);
  expect(db.calls.indexes).toEqual([]);
});

test("down drops the indexes and the keys", async () => {
  const db = fakeDb([]);
  expect(await migration.down(db, {})).toEqual({ indexesDropped: 2 });
  expect(db.calls.dropped).toHaveLength(2);
  expect(db.calls.unset).toBe(1);
});
