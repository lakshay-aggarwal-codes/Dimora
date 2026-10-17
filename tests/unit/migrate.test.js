// Migration runner logic against an in-memory fake database (no mongod).
const {
  COLLECTION,
  MigrationError,
  checksumOf,
  loadMigrations,
  readOnlyDb,
  runMigrations,
  parseArgs,
  resolveMongoUri,
  MIGRATIONS_DIR,
} = require("../../scripts/migrate");
const { FakeDb } = require("../helpers/fakeDb");
const {
  makeMigrationsDir,
  cleanupMigrationsDirs,
  migrationSource,
} = require("../helpers/migrationsDir");

const calls = () => global.__migrationCalls.map((c) => c.id);

beforeEach(() => {
  global.__migrationCalls = [];
});
afterEach(cleanupMigrationsDirs);

describe("loadMigrations", () => {
  test("sorts by number, not by text, and ignores non-js files", () => {
    const dir = makeMigrationsDir({
      "010-ten.js": migrationSource(),
      "002-two.js": migrationSource(),
      "001-one.js": migrationSource(),
      "README.md": "notes",
    });
    expect(loadMigrations(dir).map((m) => m.id)).toEqual([
      "001-one",
      "002-two",
      "010-ten",
    ]);
  });

  test("rejects badly named files", () => {
    for (const name of ["add-index.js", "1-short.js", "002_Name.js", "003-.js"]) {
      const dir = makeMigrationsDir({ [name]: migrationSource() });
      expect(() => loadMigrations(dir)).toThrow(/Invalid migration file name/);
    }
  });

  test("rejects a duplicate number", () => {
    const dir = makeMigrationsDir({
      "001-a.js": migrationSource(),
      "0001-b.js": migrationSource(),
    });
    expect(() => loadMigrations(dir)).toThrow(/share the number 1/);
  });

  test("rejects a file without up()", () => {
    const dir = makeMigrationsDir({ "001-a.js": "module.exports = {};" });
    expect(() => loadMigrations(dir)).toThrow(/must export an up/);
  });

  test("reports a missing folder", () => {
    expect(() => loadMigrations("/definitely/not/here")).toThrow(
      MigrationError,
    );
  });

  test("the checksum ignores CRLF vs LF", () => {
    expect(checksumOf("a\r\nb\r\n")).toBe(checksumOf("a\nb\n"));
    expect(checksumOf("a\n")).not.toBe(checksumOf("b\n"));
  });

  test("the shipped migrations folder loads and starts with a baseline", () => {
    const [first] = loadMigrations(MIGRATIONS_DIR);
    expect(first.id).toBe("001-baseline");
  });
});

describe("runMigrations", () => {
  test("applies pending migrations in order and records them", async () => {
    const dir = makeMigrationsDir({
      "002-second.js": migrationSource({ result: { users: 3 } }),
      "001-first.js": migrationSource(),
    });
    const db = new FakeDb();
    const lines = [];
    const summary = await runMigrations({ db, dir, log: (l) => lines.push(l) });

    expect(calls()).toEqual(["001-first", "002-second"]);
    expect(summary.applied).toEqual(["001-first", "002-second"]);
    const records = await db.collection(COLLECTION).find({}).toArray();
    expect(records.map((r) => r._id)).toEqual(["001-first", "002-second"]);
    expect(records[1].status).toBe("applied");
    expect(records[1].result).toEqual({ users: 3 });
    expect(records[1].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(records[1].appliedAt).toBeInstanceOf(Date);
    expect(lines.join("\n")).toMatch(/users=3/);
  });

  test("a second run skips applied migrations and does not rewrite", async () => {
    const dir = makeMigrationsDir({ "001-first.js": migrationSource() });
    const db = new FakeDb();
    await runMigrations({ db, dir });
    const writesAfterFirst = db.writeCount;

    const lines = [];
    const summary = await runMigrations({ db, dir, log: (l) => lines.push(l) });
    expect(calls()).toEqual(["001-first"]);
    expect(summary).toEqual({
      dryRun: false,
      skipped: ["001-first"],
      pending: [],
      applied: [],
    });
    expect(db.writeCount).toBe(writesAfterFirst);
    expect(lines.join("\n")).toMatch(/Nothing to do/);
  });

  test("only runs the new migration when one is added later", async () => {
    const files = { "001-first.js": migrationSource() };
    const dir = makeMigrationsDir(files);
    const db = new FakeDb();
    await runMigrations({ db, dir });
    require("node:fs").writeFileSync(
      require("node:path").join(dir, "002-second.js"),
      migrationSource(),
    );
    const summary = await runMigrations({ db, dir });
    expect(summary.applied).toEqual(["002-second"]);
    expect(calls()).toEqual(["001-first", "002-second"]);
  });

  test("dry run runs up() with ctx.dryRun and writes nothing", async () => {
    const dir = makeMigrationsDir({
      "001-first.js": migrationSource({ result: { would: 2 } }),
    });
    const db = new FakeDb();
    const lines = [];
    const summary = await runMigrations({
      db,
      dir,
      dryRun: true,
      log: (l) => lines.push(l),
    });
    expect(global.__migrationCalls).toEqual([
      { id: "001-first", dryRun: true },
    ]);
    expect(summary.applied).toEqual([]);
    expect(summary.pending).toEqual(["001-first"]);
    expect(db.writeCount).toBe(0);
    expect(await db.collection(COLLECTION).countDocuments()).toBe(0);
    expect(lines.join("\n")).toMatch(/would apply \(would=2\)/);
  });

  test("dry run blocks a migration that writes anyway", async () => {
    const dir = makeMigrationsDir({
      "001-bad.js": migrationSource({
        body: 'await db.collection("users").insertOne({ x: 1 });',
      }),
    });
    const db = new FakeDb();
    await expect(runMigrations({ db, dir, dryRun: true })).rejects.toThrow(
      /Dry run: the migration tried to write/,
    );
    expect(db.writeCount).toBe(0);
  });

  test("a failing migration is not recorded and stops the run", async () => {
    const dir = makeMigrationsDir({
      "001-ok.js": migrationSource(),
      "002-boom.js": migrationSource({ body: 'throw new Error("kaboom");' }),
      "003-never.js": migrationSource(),
    });
    const db = new FakeDb();
    await expect(runMigrations({ db, dir })).rejects.toThrow(
      /002-boom failed.*kaboom/,
    );
    expect(calls()).toEqual(["001-ok", "002-boom"]);
    const ids = (await db.collection(COLLECTION).find({}).toArray()).map(
      (r) => r._id,
    );
    expect(ids).toEqual(["001-ok"]);

    // Once fixed, the next run applies 002 and 003. (Jest keeps its own module
    // registry, so the rewritten file has to be dropped from it explicitly.)
    jest.resetModules();
    require("node:fs").writeFileSync(
      require("node:path").join(dir, "002-boom.js"),
      migrationSource(),
    );
    const summary = await runMigrations({ db, dir });
    expect(summary.applied).toEqual(["002-boom", "003-never"]);
  });

  test("refuses when an applied migration was edited", async () => {
    const dir = makeMigrationsDir({ "001-a.js": migrationSource() });
    const db = new FakeDb();
    await runMigrations({ db, dir });
    require("node:fs").writeFileSync(
      require("node:path").join(dir, "001-a.js"),
      migrationSource({ comment: "edited later" }),
    );
    await expect(runMigrations({ db, dir })).rejects.toThrow(
      /001-a was changed after it was applied/,
    );
  });

  test("an edit that only changes line endings is accepted", async () => {
    const source = migrationSource({ comment: "x" });
    const dir = makeMigrationsDir({ "001-a.js": source });
    const db = new FakeDb();
    await runMigrations({ db, dir });
    require("node:fs").writeFileSync(
      require("node:path").join(dir, "001-a.js"),
      source.replace(/\n/g, "\r\n"),
    );
    const summary = await runMigrations({ db, dir });
    expect(summary.skipped).toEqual(["001-a"]);
  });

  test("refuses when an applied migration's file is gone", async () => {
    const dir = makeMigrationsDir({
      "001-a.js": migrationSource(),
      "002-b.js": migrationSource(),
    });
    const db = new FakeDb();
    await runMigrations({ db, dir });
    require("node:fs").rmSync(require("node:path").join(dir, "002-b.js"));
    await expect(runMigrations({ db, dir })).rejects.toThrow(
      /002-b was applied but its file is missing/,
    );
  });

  test("refuses a new migration numbered below an applied one", async () => {
    const dir = makeMigrationsDir({ "005-late.js": migrationSource() });
    const db = new FakeDb();
    await runMigrations({ db, dir });
    require("node:fs").writeFileSync(
      require("node:path").join(dir, "003-early.js"),
      migrationSource(),
    );
    await expect(runMigrations({ db, dir })).rejects.toThrow(
      /003-early is numbered below the latest applied migration \(005-late\)/,
    );
  });

  test("refuses to start while a migration is marked running", async () => {
    const dir = makeMigrationsDir({ "001-a.js": migrationSource() });
    const db = new FakeDb();
    await db.collection(COLLECTION).insertOne({
      _id: "001-a",
      status: "running",
    });
    await expect(runMigrations({ db, dir })).rejects.toThrow(
      /001-a is marked as running/,
    );
    expect(global.__migrationCalls).toEqual([]);
  });

  test("a lost race on the unique _id is reported, not re-run", async () => {
    const dir = makeMigrationsDir({ "001-a.js": migrationSource() });
    const db = new FakeDb();
    // Another process inserts its claim after we read the (empty) history.
    const collection = db.collection(COLLECTION);
    const realFind = collection.find.bind(collection);
    collection.find = (filter) => {
      const cursor = realFind(filter);
      return {
        toArray: async () => {
          const rows = await cursor.toArray();
          await collection.insertOne({ _id: "001-a", status: "running" });
          return rows;
        },
      };
    };
    await expect(runMigrations({ db, dir })).rejects.toThrow(
      /already applied or being applied by another process/,
    );
    expect(global.__migrationCalls).toEqual([]);
  });

  test("an empty migrations folder is a no-op", async () => {
    const dir = makeMigrationsDir({});
    const summary = await runMigrations({ db: new FakeDb(), dir });
    expect(summary.applied).toEqual([]);
  });
});

describe("readOnlyDb", () => {
  test("allows reads and blocks writes, including $out/$merge", async () => {
    const db = new FakeDb();
    await db.collection("users").insertOne({ _id: 1, name: "a" });
    const guarded = readOnlyDb(db);

    const rows = await guarded.collection("users").find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(() => guarded.collection("users").deleteMany({})).toThrow(
      /Dry run/,
    );
    expect(() => guarded.collection("users").drop()).toThrow(/Dry run/);
    expect(() =>
      guarded.collection("users").aggregate([{ $match: {} }, { $out: "copy" }]),
    ).toThrow(/Dry run/);
    expect(() =>
      guarded.collection("users").aggregate([{ $merge: { into: "copy" } }]),
    ).toThrow(/Dry run/);
    expect(
      await guarded.collection("users").aggregate([{ $match: {} }]).toArray(),
    ).toEqual([]);
    expect(() => guarded.dropDatabase()).toThrow(/Dry run/);
    expect(() => guarded.createCollection("x")).toThrow(/Dry run/);
    expect(await db.collection("users").countDocuments()).toBe(1);
  });
});

describe("command line helpers", () => {
  test("parseArgs accepts only --dry-run", () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(() => parseArgs(["--reset"])).toThrow(/Unknown argument: --reset/);
  });

  test("resolveMongoUri reads MONGODB_URI, then the old ATLASDB_URL", () => {
    expect(resolveMongoUri({ MONGODB_URI: " mongodb://a/b " })).toBe(
      "mongodb://a/b",
    );
    expect(resolveMongoUri({ ATLASDB_URL: "mongodb://old/db" })).toBe(
      "mongodb://old/db",
    );
    expect(() => resolveMongoUri({})).toThrow(/MONGODB_URI is not set/);
  });
});
