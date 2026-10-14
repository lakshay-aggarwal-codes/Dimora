// User model v2 and migration 002 against a real MongoDB
// (mongodb-memory-server or TEST_MONGODB_URI). Skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser } = require("../helpers/factories");
const User = require("../../src/models/user");
const { runMigrations } = require("../../scripts/migrate");
const { up } = require("../../scripts/migrations/002-user-model-v2");

const NEW_FIELDS = {
  displayName: 1,
  role: 1,
  status: 1,
  bio: 1,
  emailVerifiedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

describeDb("user model v2 (database)", () => {
  useTestDb();

  const raw = () => mongoose.connection.db.collection("users");
  const quiet = { dryRun: false, log: () => {} };

  /** Makes a user look like it was created before this task. */
  async function makeLegacy(user, email) {
    const $set = email ? { email } : {};
    await raw().updateOne(
      { _id: user._id },
      { $unset: NEW_FIELDS, ...(email ? { $set } : {}) },
    );
  }

  test("a second account with the same email is rejected, case-insensitively", async () => {
    await createUser({ username: "first", email: "same@example.com" });
    await expect(createUser({ username: "second", email: "SAME@Example.com" }))
      .rejects.toMatchObject({ code: 11000 });
    expect(await User.countDocuments()).toBe(1);
  });

  test("signup stores the email lower-case and defaults role/status", async () => {
    const res = await createAgent().post("/signup").type("form").send({
      username: "carol",
      email: "Carol@Example.COM",
      password: "a-long-pass-phrase",
    });
    expect(res.status).toBe(302);
    const stored = await User.findOne({ username: "carol" });
    expect(stored.email).toBe("carol@example.com");
    expect(stored.displayName).toBe("carol");
    expect(stored.role).toBe("member");
    expect(stored.status).toBe("active");
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  test("signup with a taken email shows a neutral message, not a driver error", async () => {
    await createUser({ username: "owner", email: "taken@example.com" });
    const agent = createAgent();
    const res = await agent.post("/signup").type("form").send({
      username: "other",
      email: "TAKEN@example.com",
      password: "a-long-pass-phrase",
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/signup");
    const page = await agent.get("/signup");
    // neutral wording (P02-T02): does not confirm that the address is registered
    expect(page.text).toContain("create an account with those details");
    expect(page.text).not.toMatch(/E11000|already exists|duplicate/i);
    expect(await User.countDocuments()).toBe(1);
  });

  test("login works for an account created before the migration (no new fields)", async () => {
    const { user, password } = await createUser();
    await makeLegacy(user);
    expect(await raw().findOne({ _id: user._id }, { projection: { role: 1 } }))
      .not.toHaveProperty("role");

    const agent = await login(createAgent(), {
      username: user.username,
      password,
    });
    expect((await agent.get("/listings/new")).status).toBe(200);
  });

  test("migration: normalises emails, fills fields, keeps hash and salt", async () => {
    const { user, password } = await createUser({ email: "x@example.com" });
    await makeLegacy(user, "Mixed.Case@Example.com");
    const before = await raw().findOne({ _id: user._id });

    const result = await up(mongoose.connection.db, quiet);
    expect(result).toMatchObject({ scanned: 1, updated: 1, emailsNormalized: 1 });

    const after = await raw().findOne({ _id: user._id });
    expect(after.email).toBe("mixed.case@example.com");
    expect(after.displayName).toBe(user.username);
    expect(after.role).toBe("member");
    expect(after.status).toBe("active");
    expect(after.emailVerifiedAt).toBeNull();
    expect(after.createdAt).toBeInstanceOf(Date);
    expect(after.hash).toBe(before.hash);
    expect(after.salt).toBe(before.salt);
    expect(after.username).toBe(before.username);

    const agent = await login(createAgent(), {
      username: user.username,
      password,
    });
    expect((await agent.get("/listings/new")).status).toBe(200);
  });

  test("migration is idempotent and leaves the unique email index", async () => {
    const { user } = await createUser();
    await makeLegacy(user);
    await up(mongoose.connection.db, quiet);
    const snapshot = await raw().find({}).toArray();

    const second = await up(mongoose.connection.db, quiet);
    expect(second.updated).toBe(0);
    expect(await raw().find({}).toArray()).toEqual(snapshot);

    const indexes = await raw().indexes();
    const email = indexes.find((i) => i.name === "email_1");
    expect(email).toMatchObject({ key: { email: 1 }, unique: true });
  });

  test("migration with duplicate emails stops, reports, and changes nothing", async () => {
    // Without the unique index two accounts can share an address (old data).
    await raw().dropIndex("email_1").catch(() => {});
    try {
      const a = await createUser({ username: "dup_a", email: "a@example.com" });
      const b = await createUser({ username: "dup_b", email: "b@example.com" });
      await makeLegacy(a.user, "Shared@Example.com");
      await makeLegacy(b.user, "shared@example.com");
      const before = await raw().find({}).toArray();

      await expect(up(mongoose.connection.db, quiet)).rejects.toThrow(
        /dup_a.*dup_b|dup_b.*dup_a/,
      );
      expect(await raw().find({}).toArray()).toEqual(before);
      expect(await User.countDocuments()).toBe(2);
    } finally {
      await User.deleteMany({});
      await User.createIndexes();
    }
  });

  test("through the runner: dry run writes nothing, a real run records the migration", async () => {
    const { user } = await createUser();
    await makeLegacy(user, "UPPER@example.com");
    const db = mongoose.connection.db;
    await db.collection("schema_migrations").deleteMany({});

    const dry = await runMigrations({ db, dryRun: true });
    expect(dry.pending).toContain("002-user-model-v2");
    expect((await raw().findOne({ _id: user._id })).email).toBe(
      "UPPER@example.com",
    );
    expect(await db.collection("schema_migrations").countDocuments()).toBe(0);

    const real = await runMigrations({ db });
    expect(real.applied).toContain("002-user-model-v2");
    expect((await raw().findOne({ _id: user._id })).email).toBe(
      "upper@example.com",
    );
    const again = await runMigrations({ db });
    expect(again.applied).toEqual([]);
    await db.collection("schema_migrations").deleteMany({});
  });
});
