// Migration 002 (user model v2) without a database: a small in-memory fake
// covers find/bulkWrite/createIndex. The real-MongoDB run is in
// tests/integration/user.db.test.js.
const { readOnlyDb } = require("../../scripts/migrate");
const {
  up,
  planUserMigration,
  describeProblems,
  normalizeEmail,
} = require("../../scripts/migrations/002-user-model-v2");

class FakeUsers {
  constructor(docs) {
    this.docs = docs;
    this.writes = 0;
    this.indexes = [];
  }

  find() {
    return { toArray: async () => this.docs.map((doc) => ({ ...doc })) };
  }

  async bulkWrite(operations) {
    let modifiedCount = 0;
    for (const { updateOne } of operations) {
      const doc = this.docs.find((d) =>
        Object.entries(updateOne.filter).every(([k, v]) => d[k] === v),
      );
      if (doc) {
        Object.assign(doc, updateOne.update.$set);
        modifiedCount += 1;
        this.writes += 1;
      }
    }
    return { modifiedCount };
  }

  async createIndex(spec, options) {
    this.writes += 1;
    this.indexes.push({ spec, options });
  }
}

function fakeDb(docs) {
  const users = new FakeUsers(docs);
  return { users, collection: () => users };
}

const legacy = (n, email, extra = {}) => ({
  _id: `id${n}`,
  username: `user${n}`,
  email,
  hash: `hash${n}`,
  salt: `salt${n}`,
  ...extra,
});

describe("normalizeEmail", () => {
  test("trims and lower-cases; anything else is null", () => {
    expect(normalizeEmail("  Ann@Example.COM ")).toBe("ann@example.com");
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});

describe("planUserMigration", () => {
  test("fills the missing fields of a legacy user and lower-cases the email", () => {
    const plan = planUserMigration([legacy(1, "Ann@Example.com")]);
    expect(plan.duplicates).toEqual([]);
    expect(plan.withoutEmail).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    const { set } = plan.updates[0];
    expect(set.email).toBe("ann@example.com");
    expect(set.displayName).toBe("user1");
    expect(set.role).toBe("member");
    expect(set.status).toBe("active");
    expect(set.bio).toBe("");
    expect(set.emailVerifiedAt).toBeNull();
    expect(set.createdAt).toBeInstanceOf(Date);
    expect(set.updatedAt).toEqual(set.createdAt);
    expect(plan.counts.emailsNormalized).toBe(1);
  });

  test("never plans a change to hash, salt or username", () => {
    const { set } = planUserMigration([legacy(1, "a@x.com")]).updates[0];
    expect(Object.keys(set)).not.toEqual(
      expect.arrayContaining(["hash", "salt", "username"]),
    );
  });

  test("a user that is already migrated needs no update", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const plan = planUserMigration([
      legacy(1, "a@x.com", {
        displayName: "Ann",
        role: "admin",
        status: "suspended",
        bio: "hi",
        emailVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    expect(plan.updates).toEqual([]);
  });

  test("keeps existing values (role, status, display name)", () => {
    const { set } = planUserMigration([
      legacy(1, "a@x.com", { role: "admin", displayName: "Ann" }),
    ]).updates[0];
    expect(set.role).toBeUndefined();
    expect(set.displayName).toBeUndefined();
  });

  test("addresses that differ only by case or spaces are duplicates", () => {
    const plan = planUserMigration([
      legacy(1, "Ann@Example.com"),
      legacy(2, " ann@example.com "),
      legacy(3, "bob@example.com"),
    ]);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].users.map((u) => u.id)).toEqual(["id1", "id2"]);
    expect(plan.counts.duplicateEmailGroups).toBe(1);
  });

  test("users without a usable email are reported, not updated", () => {
    const plan = planUserMigration([
      legacy(1, undefined),
      legacy(2, "  "),
      legacy(3, "c@x.com"),
    ]);
    expect(plan.withoutEmail.map((u) => u.id)).toEqual(["id1", "id2"]);
    expect(plan.updates.map((u) => u._id)).toEqual(["id3"]);
  });

  test("problem lines name ids and usernames but never an email", () => {
    const lines = describeProblems(
      planUserMigration([
        legacy(1, "dup@example.com"),
        legacy(2, "DUP@example.com"),
      ]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("id1 (user1)");
    expect(lines[0]).toContain("id2 (user2)");
    expect(lines[0].toLowerCase()).not.toContain("dup@example.com");
  });
});

describe("migration 002 up()", () => {
  test("updates users, builds the unique email index, keeps hashes", async () => {
    const db = fakeDb([legacy(1, "Ann@Example.com"), legacy(2, "bob@x.com")]);
    const result = await up(db, { dryRun: false, log: () => {} });

    expect(result).toEqual({
      scanned: 2,
      updated: 2,
      emailsNormalized: 1,
      indexes: 1,
    });
    expect(db.users.docs[0].email).toBe("ann@example.com");
    expect(db.users.docs[0].role).toBe("member");
    expect(db.users.docs.map((d) => d.hash)).toEqual(["hash1", "hash2"]);
    expect(db.users.docs.map((d) => d.salt)).toEqual(["salt1", "salt2"]);
    expect(db.users.indexes).toEqual([
      { spec: { email: 1 }, options: { unique: true, name: "email_1" } },
    ]);
  });

  test("a second run changes nothing", async () => {
    const db = fakeDb([legacy(1, "Ann@Example.com")]);
    await up(db, { dryRun: false, log: () => {} });
    const snapshot = JSON.stringify(db.users.docs);
    const second = await up(db, { dryRun: false, log: () => {} });
    expect(second.updated).toBe(0);
    expect(second.emailsNormalized).toBe(0);
    expect(JSON.stringify(db.users.docs)).toBe(snapshot);
  });

  test("duplicate emails: throws with a report and writes nothing", async () => {
    const db = fakeDb([
      legacy(1, "dup@example.com"),
      legacy(2, "DUP@example.com"),
      legacy(3, "fine@example.com"),
    ]);
    const lines = [];
    await expect(
      up(db, { dryRun: false, log: (m) => lines.push(m) }),
    ).rejects.toThrow(/id1 \(user1\), id2 \(user2\)/);
    expect(db.users.writes).toBe(0);
    expect(db.users.docs[2].role).toBeUndefined();
    expect(lines.join("\n")).toContain("PROBLEM");
  });

  test("dry run reports counts and problems, writes nothing, does not throw", async () => {
    const db = fakeDb([
      legacy(1, "dup@example.com"),
      legacy(2, "dup@example.com"),
      legacy(3, "Ok@example.com"),
    ]);
    const result = await up(readOnlyDb(db), { dryRun: true, log: () => {} });
    expect(result.scanned).toBe(3);
    expect(result.duplicateEmailGroups).toBe(1);
    expect(result.wouldBlock).toBe(1);
    expect(db.users.writes).toBe(0);
  });

  test("dry run on clean data counts what would change and writes nothing", async () => {
    const db = fakeDb([legacy(1, "A@x.com")]);
    const result = await up(readOnlyDb(db), { dryRun: true, log: () => {} });
    expect(result).toMatchObject({
      scanned: 1,
      toUpdate: 1,
      emailsNormalized: 1,
      wouldBlock: 0,
    });
    expect(db.users.writes).toBe(0);
    expect(db.users.docs[0].email).toBe("A@x.com");
  });
});
