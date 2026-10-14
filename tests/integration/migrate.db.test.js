// Migration runner against a real MongoDB (mongodb-memory-server or
// TEST_MONGODB_URI): unique-_id claim, dry run creating nothing, and the
// shipped baseline migration. Skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const {
  makeMigrationsDir,
  cleanupMigrationsDirs,
  migrationSource,
} = require("../helpers/migrationsDir");
const {
  COLLECTION,
  MIGRATIONS_DIR,
  runMigrations,
} = require("../../scripts/migrate");

describeDb("migration runner (database)", () => {
  useTestDb();

  const db = () => mongoose.connection.db;
  const calls = () => global.__migrationCalls.map((c) => c.id);

  async function collectionNames() {
    return (await db().listCollections().toArray()).map((c) => c.name);
  }

  beforeEach(async () => {
    global.__migrationCalls = [];
    // useTestDb only empties collections registered as Mongoose models.
    await db().collection(COLLECTION).deleteMany({});
    await db().collection("migration_test_items").deleteMany({});
  });
  afterEach(cleanupMigrationsDirs);

  test("applies in order, records them, and a second run is a no-op", async () => {
    const dir = makeMigrationsDir({
      "001-first.js": migrationSource(),
      "002-second.js": migrationSource({
        body: 'await db.collection("migration_test_items").insertOne({ n: 1 });',
        result: { inserted: 1 },
      }),
    });

    const first = await runMigrations({ db: db(), dir });
    expect(first.applied).toEqual(["001-first", "002-second"]);
    expect(calls()).toEqual(["001-first", "002-second"]);
    expect(
      await db().collection("migration_test_items").countDocuments(),
    ).toBe(1);

    const records = await db()
      .collection(COLLECTION)
      .find({})
      .sort({ _id: 1 })
      .toArray();
    expect(records.map((r) => r._id)).toEqual(["001-first", "002-second"]);
    expect(records[1].status).toBe("applied");
    expect(records[1].result).toEqual({ inserted: 1 });

    const second = await runMigrations({ db: db(), dir });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001-first", "002-second"]);
    expect(calls()).toEqual(["001-first", "002-second"]); // up() not called again
    expect(
      await db().collection("migration_test_items").countDocuments(),
    ).toBe(1);
  });

  test("dry run writes nothing, not even the schema_migrations collection", async () => {
    await db().collection(COLLECTION).drop().catch(() => {});
    const dir = makeMigrationsDir({
      "001-first.js": migrationSource({ result: { would: 1 } }),
    });
    const summary = await runMigrations({ db: db(), dir, dryRun: true });

    expect(summary.pending).toEqual(["001-first"]);
    expect(summary.applied).toEqual([]);
    expect(await collectionNames()).not.toContain(COLLECTION);
  });

  test("dry run stops a migration that tries to write", async () => {
    const dir = makeMigrationsDir({
      "001-bad.js": migrationSource({
        body: 'await db.collection("migration_test_items").insertOne({ n: 1 });',
      }),
    });
    await expect(
      runMigrations({ db: db(), dir, dryRun: true }),
    ).rejects.toThrow(/Dry run: the migration tried to write/);
    expect(
      await db().collection("migration_test_items").countDocuments(),
    ).toBe(0);
  });

  test("an existing record for the id blocks a second claim", async () => {
    const dir = makeMigrationsDir({ "001-first.js": migrationSource() });
    await runMigrations({ db: db(), dir });
    // The unique _id index is what stops two processes claiming one migration.
    await expect(
      db().collection(COLLECTION).insertOne({ _id: "001-first" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test("a failing migration leaves no record and later ones do not run", async () => {
    const dir = makeMigrationsDir({
      "001-ok.js": migrationSource(),
      "002-boom.js": migrationSource({ body: 'throw new Error("kaboom");' }),
      "003-never.js": migrationSource(),
    });
    await expect(runMigrations({ db: db(), dir })).rejects.toThrow(/kaboom/);
    const ids = (await db().collection(COLLECTION).find({}).toArray()).map(
      (r) => r._id,
    );
    expect(ids).toEqual(["001-ok"]);
    expect(calls()).toEqual(["001-ok", "002-boom"]);
  });

  test("the shipped migrations apply on an empty database, twice safely", async () => {
    const first = await runMigrations({ db: db(), dir: MIGRATIONS_DIR });
    expect(first.applied).toContain("001-baseline");

    const second = await runMigrations({ db: db(), dir: MIGRATIONS_DIR });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain("001-baseline");
  });
});
