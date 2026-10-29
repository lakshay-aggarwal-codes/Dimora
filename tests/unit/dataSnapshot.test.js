// P17-T05: the data fingerprint used in the restore rehearsal.
const assert = require("node:assert/strict");
const { buildSnapshot, compareSnapshots } = require("../../scripts/lib/dataSnapshot");

function fakeDb(spec, migrations = []) {
  return {
    databaseName: "dimora",
    listCollections: () => ({ toArray: async () => Object.keys(spec).map((name) => ({ name })) }),
    collection: (name) => ({
      countDocuments: async () => spec[name].count,
      indexes: async () => spec[name].indexes.map((n) => ({ name: n })),
      find: () => ({ toArray: async () => migrations.map((id) => ({ _id: id })) }),
    }),
  };
}

const SPEC = {
  users: { count: 10, indexes: ["_id_", "email_1"] },
  stay_nights: { count: 40, indexes: ["_id_", "listing_1_night_1"] },
  schema_migrations: { count: 2, indexes: ["_id_"] },
  sessions: { count: 5, indexes: ["_id_"] },
  "system.views": { count: 0, indexes: [] },
};

test("a snapshot lists counts, sorted index names and migrations, and skips system collections", async () => {
  const snap = await buildSnapshot(fakeDb(SPEC, ["002-b", "001-a"]), new Date("2026-10-28T00:00:00Z"));
  assert.equal(snap.database, "dimora");
  assert.deepEqual(Object.keys(snap.collections), ["schema_migrations", "sessions", "stay_nights", "users"]);
  assert.deepEqual(snap.collections.users, { count: 10, indexes: ["_id_", "email_1"] });
  assert.deepEqual(snap.migrations, ["001-a", "002-b"]);
  assert.equal(snap.takenAt, "2026-10-28T00:00:00.000Z");
});

test("identical snapshots match", async () => {
  const a = await buildSnapshot(fakeDb(SPEC, ["001-a"]));
  const b = await buildSnapshot(fakeDb(SPEC, ["001-a"]));
  assert.deepEqual(compareSnapshots(a, b), { same: true, differences: [], notes: [] });
});

test("a lost document, a lost index, a missing collection and a lost migration all fail", async () => {
  const a = await buildSnapshot(fakeDb(SPEC, ["001-a", "002-b"]));
  const broken = JSON.parse(JSON.stringify(a));
  broken.collections.users.count = 9;
  broken.collections.stay_nights.indexes = ["_id_"];
  delete broken.collections.schema_migrations;
  broken.migrations = ["001-a"];
  const out = compareSnapshots(a, broken);
  assert.equal(out.same, false);
  assert.ok(out.differences.some((d) => d.startsWith("users: 10 documents, then 9")));
  assert.ok(out.differences.some((d) => /stay_nights: indexes missing.*listing_1_night_1/.test(d)));
  assert.ok(out.differences.some((d) => d.startsWith("schema_migrations: missing")));
  assert.ok(out.differences.some((d) => /002-b/.test(d)));
});

test("sessions changing is a note, not a failure; an extra index is a note", async () => {
  const a = await buildSnapshot(fakeDb(SPEC));
  const b = JSON.parse(JSON.stringify(a));
  b.collections.sessions.count = 0;
  b.collections.users.indexes.push("extra_1");
  const out = compareSnapshots(a, b);
  assert.equal(out.same, true);
  assert.equal(out.notes.length, 2);
});

test("a collection only in the restored copy is reported", async () => {
  const a = await buildSnapshot(fakeDb(SPEC));
  const b = JSON.parse(JSON.stringify(a));
  b.collections.surprise = { count: 1, indexes: ["_id_"] };
  assert.equal(compareSnapshots(a, b).same, false);
});
