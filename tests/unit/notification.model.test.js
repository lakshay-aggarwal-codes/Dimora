// P11-T01: the Notification schema (validation and indexes, no database).
const Notification = require("../../src/models/notification");
const { LIMITS, REF_KINDS } = require("../../src/config/notifications");

const ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const valid = (over = {}) => ({
  user: ID,
  type: "reservation.requested",
  title: "New booking request",
  ...over,
});
const errorsOf = (data) => {
  const err = new Notification(data).validateSync();
  return err ? Object.keys(err.errors) : [];
};

describe("validation", () => {
  test("a minimal notification is valid and starts unread with no delete date", () => {
    const n = new Notification(valid());
    expect(n.validateSync()).toBeUndefined();
    expect(n.readAt).toBeNull();
    expect(n.deleteAfter).toBeUndefined();
  });

  test("user, type and title are required", () => {
    expect(errorsOf({})).toEqual(
      expect.arrayContaining(["user", "type", "title"]),
    );
  });

  test.each(["requested", "Reservation.Requested", "a b.c", "a..b", ".a.b"])(
    "type %j is refused",
    (type) => {
      expect(errorsOf(valid({ type }))).toContain("type");
    },
  );

  test("title, text and link have length limits", () => {
    expect(errorsOf(valid({ title: "x".repeat(LIMITS.title + 1) }))).toContain(
      "title",
    );
    expect(errorsOf(valid({ body: "x".repeat(LIMITS.body + 1) }))).toContain(
      "body",
    );
    expect(errorsOf(valid({ url: `/${"x".repeat(LIMITS.url)}` }))).toContain(
      "url",
    );
    expect(
      errorsOf(valid({ title: "x".repeat(LIMITS.title), body: "y".repeat(LIMITS.body) })),
    ).toEqual([]);
  });

  test("a reference needs a known kind", () => {
    for (const kind of REF_KINDS) {
      expect(errorsOf(valid({ ref: { kind, id: ID } }))).toEqual([]);
    }
    expect(errorsOf(valid({ ref: { kind: "payment", id: ID } }))).toContain(
      "ref.kind",
    );
  });

  test("timestamps: createdAt only", () => {
    expect(Notification.schema.path("createdAt")).toBeDefined();
    expect(Notification.schema.path("updatedAt")).toBeUndefined();
  });
});

describe("indexes", () => {
  const indexes = Notification.schema.indexes();

  test("the list and the unread count are served by (user, readAt, createdAt)", () => {
    expect(
      indexes.some(
        ([key]) => key.user === 1 && key.readAt === 1 && key.createdAt === -1,
      ),
    ).toBe(true);
  });

  test("a TTL index on deleteAfter removes a row when that date passes", () => {
    const ttl = indexes.find(([key]) => key.deleteAfter === 1);
    expect(ttl).toBeDefined();
    expect(ttl[1].expireAfterSeconds).toBe(0);
  });
});
