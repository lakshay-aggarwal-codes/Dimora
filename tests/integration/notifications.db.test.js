// P11-T01 against a real MongoDB: the stored shape, the indexes (including the
// TTL), recipient scoping and the mark-read updates. Skipped with
// SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/notifications.db.test.js
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser } = require("../helpers/factories");
const Notification = require("../../src/models/notification");
const service = require("../../src/services/notifications");
const { NotFoundError } = require("../../src/utils/errors");
const { READ_RETENTION_DAYS } = require("../../src/config/notifications");

describeDb("notifications (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Notification.init();
  });

  async function twoMembers() {
    const ann = (await createUser()).user;
    const ben = (await createUser()).user;
    return { ann, ben };
  }
  const give = (user, title, over = {}) =>
    service.notify(
      user._id,
      "reservation.requested",
      { kind: "reservation", id: user._id },
      { title, ...over },
    );

  test("the TTL and list indexes exist", async () => {
    const indexes = await Notification.collection.indexes();
    const ttl = indexes.find((i) => i.key.deleteAfter === 1);
    expect(ttl).toBeDefined();
    expect(ttl.expireAfterSeconds).toBe(0);
    expect(
      indexes.some(
        (i) => i.key.user === 1 && i.key.readAt === 1 && i.key.createdAt === -1,
      ),
    ).toBe(true);
  });

  test("notify stores one unread row for the recipient, with no delete date", async () => {
    const { ann, ben } = await twoMembers();
    const row = await give(ann, "Hello", { body: "Text", url: "/trips" });
    const stored = await Notification.findById(row._id).lean();
    expect(String(stored.user)).toBe(String(ann._id));
    expect(stored).toMatchObject({
      type: "reservation.requested",
      title: "Hello",
      body: "Text",
      url: "/trips",
      readAt: null,
    });
    expect(stored.ref.kind).toBe("reservation");
    expect(stored.deleteAfter).toBeUndefined();
    expect(await Notification.countDocuments({})).toBe(1);
    expect(await service.countUnread(ben._id)).toBe(0);
    expect(await service.countUnread(ann._id)).toBe(1);
  });

  test("an invalid notification writes nothing", async () => {
    const { ann } = await twoMembers();
    await expect(give(ann, "x", { url: "https://evil.example/" })).rejects.toThrow();
    await expect(give(ann, "")).rejects.toThrow();
    expect(await Notification.countDocuments({})).toBe(0);
  });

  test("the list is newest first and private to its member", async () => {
    const { ann, ben } = await twoMembers();
    await give(ann, "First");
    await give(ben, "Ben's");
    await give(ann, "Second");
    const list = await service.listFor(ann._id);
    expect(list.items.map((i) => i.title)).toEqual(["Second", "First"]);
    expect((await service.listFor(ben._id)).items.map((i) => i.title)).toEqual([
      "Ben's",
    ]);
  });

  test("marking read sets readAt and a delete date 30 days on; again does nothing", async () => {
    const { ann } = await twoMembers();
    const row = await give(ann, "Mine");
    const now = new Date("2026-10-24T12:00:00Z");
    expect(await service.markRead(ann._id, row._id, { now })).toEqual({
      changed: true,
    });
    const stored = await Notification.findById(row._id).lean();
    expect(stored.readAt).toEqual(now);
    expect(stored.deleteAfter).toEqual(
      new Date(now.getTime() + READ_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );
    expect(
      await service.markRead(ann._id, row._id, {
        now: new Date("2026-12-01T00:00:00Z"),
      }),
    ).toEqual({ changed: false });
    expect((await Notification.findById(row._id).lean()).readAt).toEqual(now);
  });

  test("someone else's notification: 404 and still unread", async () => {
    const { ann, ben } = await twoMembers();
    const row = await give(ben, "Ben's");
    await expect(service.markRead(ann._id, row._id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await Notification.findById(row._id).lean()).readAt).toBeNull();
  });

  test("read-all touches only that member's unread rows", async () => {
    const { ann, ben } = await twoMembers();
    await give(ann, "A1");
    await give(ann, "A2");
    await give(ben, "B1");
    expect(await service.markAllRead(ann._id)).toEqual({ updated: 2 });
    expect(await service.countUnread(ann._id)).toBe(0);
    expect(await service.countUnread(ben._id)).toBe(1);
    expect(await Notification.countDocuments({ deleteAfter: { $type: "date" } })).toBe(2);
  });

  test("unread rows have no delete date, so the TTL index never removes them", async () => {
    const { ann } = await twoMembers();
    await give(ann, "Stays");
    expect(await Notification.countDocuments({ deleteAfter: { $exists: false } })).toBe(1);
  });
});
