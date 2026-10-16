// Migration 005 (listing wizard index), no database.
const migration = require("../../scripts/migrations/005-listing-wizard");

function fakeDb() {
  const calls = { created: [], dropped: [] };
  const collection = {
    async createIndex(spec, options) {
      calls.created.push({ spec, options });
    },
    async dropIndex(name) {
      calls.dropped.push(name);
      if (name === "missing") {
        const err = new Error("not found");
        err.codeName = "IndexNotFound";
        throw err;
      }
    },
  };
  return { calls, collection: () => collection };
}

test("up builds the unique partial index; a dry run builds nothing", async () => {
  const db = fakeDb();
  expect(await migration.up(db, { dryRun: true })).toEqual({ indexes: 1 });
  expect(db.calls.created).toEqual([]);

  expect(await migration.up(db, {})).toEqual({ indexes: 1 });
  expect(db.calls.created).toEqual([
    {
      spec: { owner: 1, draftToken: 1 },
      options: {
        name: "owner_1_draftToken_1",
        unique: true,
        partialFilterExpression: { draftToken: { $type: "string" } },
      },
    },
  ]);
});

test("down drops it, and a missing index is not an error", async () => {
  const db = fakeDb();
  expect(await migration.down(db)).toEqual({ indexesDropped: 1 });
  expect(db.calls.dropped).toEqual(["owner_1_draftToken_1"]);
});
