// P11-T02 against a real MongoDB: the unique thread index (also under parallel
// requests), the unread counters, paging by message id and the list. Skipped
// with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/conversations.db.test.js
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const Conversation = require("../../src/models/conversation");
const Message = require("../../src/models/message");
const service = require("../../src/services/conversations");
const { NotFoundError } = require("../../src/utils/errors");
const { PAGE_SIZE } = require("../../src/config/conversations");

describeDb("conversations (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Conversation.init();
    await Message.init();
  });

  async function world() {
    const host = (await createUser()).user;
    const guest = (await createUser()).user;
    const other = (await createUser()).user;
    const listing = await createListing({ owner: host });
    return { host, guest, other, listing };
  }

  test("the unique thread index exists", async () => {
    const index = (await Conversation.collection.indexes()).find((i) => i.key.threadKey === 1);
    expect(index.unique).toBe(true);
  });

  test("many clicks at once make one conversation", async () => {
    const { guest, listing } = await world();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.startForListing({}, guest, String(listing._id))),
    );
    expect(new Set(results.map((r) => String(r.conversation._id))).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await Conversation.countDocuments({})).toBe(1);
  });

  test("a booking-bound thread is separate and shared by both sides", async () => {
    const { host, guest, listing } = await world();
    const Reservation = require("../../src/models/reservation");
    const reservation = await Reservation.collection.insertOne({
      listing: listing._id,
      guest: guest._id,
      host: host._id,
    });
    const a = await service.startForReservation({}, guest, String(reservation.insertedId));
    const b = await service.startForReservation({}, host, String(reservation.insertedId));
    expect(String(a.conversation._id)).toBe(String(b.conversation._id));
    expect(String(a.conversation.reservation)).toBe(String(reservation.insertedId));
  });

  test("sending keeps one counter per side and the list shows it", async () => {
    const { host, guest, other, listing } = await world();
    const { conversation } = await service.startForListing({}, guest, String(listing._id));
    const cid = String(conversation._id);
    await service.send({}, guest, cid, "One");
    await service.send({}, guest, cid, "Two");
    await service.send({}, host, cid, "Three");
    const stored = await Conversation.findById(cid).lean();
    expect(stored.unread).toEqual({ guest: 1, host: 2 });
    expect((await service.listFor({}, host)).conversations[0].unread).toBe(2);
    await service.thread({}, host, cid);
    expect((await Conversation.findById(cid).lean()).unread).toEqual({ guest: 1, host: 0 });
    await expect(service.thread({}, other, cid)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.send({}, other, cid, "hi")).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a thread pages by message id, newest page first", async () => {
    const { guest, listing } = await world();
    const { conversation } = await service.startForListing({}, guest, String(listing._id));
    const cid = String(conversation._id);
    for (let i = 1; i <= PAGE_SIZE + 5; i += 1) await service.send({}, guest, cid, `M${i}`);
    const first = await service.thread({}, guest, cid);
    expect(first.messages).toHaveLength(PAGE_SIZE);
    expect(first.messages[PAGE_SIZE - 1].body).toBe(`M${PAGE_SIZE + 5}`);
    const older = await service.thread({}, guest, cid, { before: first.nextBefore });
    expect(older.messages.map((m) => m.body)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
    expect(older.hasMore).toBe(false);
  });
});
