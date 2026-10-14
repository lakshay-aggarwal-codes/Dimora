// User model v2 rules that need no database (validation runs without a
// connection). Uniqueness and the migration against a real MongoDB are in
// tests/integration/user.db.test.js.
const User = require("../../src/models/user");

const base = (overrides = {}) => ({
  username: "ann",
  email: "ann@example.com",
  ...overrides,
});

describe("User model v2", () => {
  test("email is trimmed and lower-cased", () => {
    const user = new User(base({ email: "  Ann@Example.COM " }));
    expect(user.email).toBe("ann@example.com");
  });

  test("defaults: member, active, empty bio, not verified", () => {
    const user = new User(base());
    expect(user.role).toBe("member");
    expect(user.status).toBe("active");
    expect(user.bio).toBe("");
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.avatar && user.avatar.url).toBeFalsy();
  });

  test("displayName falls back to the username on validate", async () => {
    const user = new User(base());
    await user.validate();
    expect(user.displayName).toBe("ann");
  });

  test("an explicit displayName is kept (and trimmed)", async () => {
    const user = new User(base({ displayName: "  Ann A.  " }));
    await user.validate();
    expect(user.displayName).toBe("Ann A.");
  });

  test("email is required and must look like an address", () => {
    expect(new User({ username: "x" }).validateSync().errors.email).toBeDefined();
    for (const bad of ["plain", "a@b", "a b@c.de", "@x.com"]) {
      const err = new User(base({ email: bad })).validateSync();
      expect(err && err.errors.email).toBeDefined();
    }
  });

  test("role and status only accept the known values", () => {
    expect(
      new User(base({ role: "superuser" })).validateSync().errors.role,
    ).toBeDefined();
    expect(
      new User(base({ status: "banned" })).validateSync().errors.status,
    ).toBeDefined();
    expect(new User(base({ role: "admin" })).validateSync()).toBeUndefined();
    expect(
      new User(base({ status: "suspended" })).validateSync(),
    ).toBeUndefined();
  });

  test("length limits: bio 500, display name 60", () => {
    expect(
      new User(base({ bio: "x".repeat(501) })).validateSync().errors.bio,
    ).toBeDefined();
    expect(
      new User(base({ displayName: "x".repeat(61) })).validateSync().errors
        .displayName,
    ).toBeDefined();
  });

  test("declares a unique index on email and timestamps", () => {
    const emailIndex = User.schema
      .indexes()
      .find(([spec]) => spec.email === 1);
    expect(emailIndex).toBeDefined();
    expect(emailIndex[1].unique).toBe(true);
    expect(User.schema.path("createdAt")).toBeDefined();
    expect(User.schema.path("updatedAt")).toBeDefined();
  });

  test("exports the allowed roles and statuses", () => {
    expect(User.ROLES).toEqual(["member", "admin"]);
    expect(User.STATUSES).toEqual(["active", "suspended", "deleted"]);
  });
});
