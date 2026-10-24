// P11-T02: src/services/conversations.js against in-memory models (no
// database). The database-backed checks are in
// tests/integration/conversations.db.test.js.
const { fakeCollection } = require("../helpers/fakeCollection");
const service = require("../../src/services/conversations");
const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require("../../src/utils/errors");
const { LIMITS, PAGE_SIZE, LIST_SIZE } = require("../../src/config/conversations");

const id = (n) => String(n).padStart(24, "0");
const ANN = id(1); // guest
const HAL = id(2); // host
const EVE = id(3); // outsider
const ROOT = id(4); // admin
const SAM = id(5); // suspended host
const LISTING = id(10);
const DRAFT = id(11);
const GONE = id(12);
const SAMS_LISTING = id(13);
const BOOKING = id(20);

const person = (_id, username, extra = {}) => ({
  _id,
  username,
  displayName: username,
  role: "member",
  status: "active",
  ...extra,
});
const ann = person(ANN, "ann");
const hal = person(HAL, "hal");
const eve = person(EVE, "eve");
const root = person(ROOT, "root", { role: "admin" });

let deps;
let clockNow;
beforeEach(() => {
  clockNow = new Date("2026-10-24T12:00:00Z");
  deps = {
    ConversationModel: fakeCollection({
      uniqueKey: "threadKey",
      defaults: () => ({
        unread: { guest: 0, host: 0 },
        lastMessageAt: null,
        reservation: null,
      }),
    }),
    MessageModel: fakeCollection(),
    UserModel: fakeCollection().seed(
      ann,
      hal,
      eve,
      root,
      person(SAM, "sam", { status: "suspended" }),
    ),
    ListingModel: fakeCollection().seed(
      { _id: LISTING, owner: HAL, status: "published", deletedAt: null, title: "Sea house" },
      { _id: DRAFT, owner: HAL, status: "draft", deletedAt: null, title: "Draft" },
      { _id: GONE, owner: HAL, status: "published", deletedAt: new Date(), title: "Gone" },
      { _id: SAMS_LISTING, owner: SAM, status: "published", deletedAt: null, title: "Sam's" },
    ),
    ReservationModel: fakeCollection().seed({
      _id: BOOKING,
      listing: LISTING,
      guest: ANN,
      host: HAL,
    }),
  };
  Object.defineProperty(deps, "now", { get: () => clockNow, enumerable: true });
});

const start = (user = ann, listing = LISTING) =>
  service.startForListing(deps, user, listing);
const say = (user, conversationId, body) =>
  service.send(deps, user, conversationId, body);

describe("startForListing (Contact host)", () => {
  test("creates the general conversation for this guest, host and listing", async () => {
    const { conversation, created } = await start();
    expect(created).toBe(true);
    expect(conversation).toMatchObject({
      guest: ANN,
      host: HAL,
      listing: LISTING,
      reservation: null,
      threadKey: `listing:${LISTING}:${ANN}`,
    });
    expect(deps.ConversationModel.rows).toHaveLength(1);
  });

  test("again, and two clicks at once, give the same conversation", async () => {
    const [a, b] = await Promise.all([start(), start()]);
    expect(String(a.conversation._id)).toBe(String(b.conversation._id));
    const c = await start();
    expect(c.created).toBe(false);
    expect(deps.ConversationModel.rows).toHaveLength(1);
  });

  test("each guest gets their own conversation with the same host", async () => {
    const a = await start(ann);
    const b = await start(eve);
    expect(String(a.conversation._id)).not.toBe(String(b.conversation._id));
  });

  test("your own listing is refused", async () => {
    await expect(start(hal)).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.ConversationModel.rows).toHaveLength(0);
  });

  test.each([
    ["a draft", DRAFT],
    ["a deleted listing", GONE],
    ["an unknown listing", id(99)],
    ["a malformed id", "nope"],
    ["an operator", { $ne: "" }],
  ])("%s is a 404", async (_name, listing) => {
    await expect(start(ann, listing)).rejects.toBeInstanceOf(NotFoundError);
    expect(deps.ConversationModel.rows).toHaveLength(0);
  });

  test("a suspended host cannot be contacted", async () => {
    await expect(start(ann, SAMS_LISTING)).rejects.toBeInstanceOf(ConflictError);
    expect(deps.ConversationModel.rows).toHaveLength(0);
  });

  test("a suspended or signed-out member cannot start one", async () => {
    await expect(
      start(person(ANN, "ann", { status: "suspended" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.startForListing(deps, undefined, LISTING),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.ConversationModel.rows).toHaveLength(0);
  });
});

describe("startForReservation", () => {
  test("the guest and the host open the same booking-bound conversation", async () => {
    const a = await service.startForReservation(deps, ann, BOOKING);
    const b = await service.startForReservation(deps, hal, BOOKING);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(String(a.conversation._id)).toBe(String(b.conversation._id));
    expect(a.conversation).toMatchObject({
      reservation: BOOKING,
      listing: LISTING,
      guest: ANN,
      host: HAL,
      threadKey: `reservation:${BOOKING}`,
    });
  });

  test("it is separate from the general conversation", async () => {
    const general = await start();
    const bound = await service.startForReservation(deps, ann, BOOKING);
    expect(String(general.conversation._id)).not.toBe(String(bound.conversation._id));
  });

  test.each([
    ["an outsider", eve, BOOKING],
    ["an admin", root, BOOKING],
    ["an unknown booking", ann, id(98)],
    ["a malformed id", ann, "x"],
  ])("%s gets a 404", async (_name, user, booking) => {
    await expect(
      service.startForReservation(deps, user, booking),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(deps.ConversationModel.rows).toHaveLength(0);
  });

  test("not while either account is suspended", async () => {
    deps.UserModel.rows.find((u) => u._id === HAL).status = "suspended";
    await expect(
      service.startForReservation(deps, ann, BOOKING),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("send", () => {
  test("stores the message and raises only the other side's unread counter", async () => {
    const { conversation } = await start();
    const message = await say(ann, conversation._id, "  Is the cot free?  ");
    expect(message).toMatchObject({ body: "Is the cot free?", mine: true });
    const stored = deps.ConversationModel.rows[0];
    expect(stored.unread).toEqual({ guest: 0, host: 1 });
    expect(stored.lastMessageAt).toEqual(clockNow);
    expect(stored.lastMessage).toEqual({ sender: ANN, preview: "Is the cot free?" });
    await say(hal, conversation._id, "Yes.");
    await say(hal, conversation._id, "Anything else?");
    expect(deps.ConversationModel.rows[0].unread).toEqual({ guest: 2, host: 1 });
    expect(deps.MessageModel.rows.map((m) => m.sender)).toEqual([ANN, HAL, HAL]);
  });

  test("a hostile message is stored as plain text, unchanged", async () => {
    const { conversation } = await start();
    const payload = `<img src=x onerror=alert(1)><script>alert("x")</script>`;
    const message = await say(ann, conversation._id, payload);
    expect(message.body).toBe(payload);
    expect(deps.MessageModel.rows[0].body).toBe(payload);
  });

  test("line breaks are kept (as \\n) and tabs are allowed", async () => {
    const { conversation } = await start();
    const message = await say(ann, conversation._id, "one\r\ntwo\tthree\rfour");
    expect(message.body).toBe("one\ntwo\tthree\nfour");
  });

  test("outsiders and admins get a 404 and nothing is stored", async () => {
    const { conversation } = await start();
    for (const user of [eve, root]) {
      await expect(say(user, conversation._id, "hi")).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(deps.MessageModel.rows).toHaveLength(0);
  });

  test.each(["", "nope", id(99), { $ne: 1 }])("a bad conversation id (%j) is a 404", async (bad) => {
    await expect(say(ann, bad, "hi")).rejects.toBeInstanceOf(NotFoundError);
  });

  test.each([
    ["nothing", undefined],
    ["a number", 5],
    ["an object", { $gt: "" }],
    ["an array", ["hi"]],
    ["only spaces", "  \n\t "],
    ["a control character", "a\u0000b"],
    ["an escape character", "a\u001bb"],
  ])("%s is refused and stores nothing", async (_name, body) => {
    const { conversation } = await start();
    await expect(say(ann, conversation._id, body)).rejects.toBeInstanceOf(ValidationError);
    expect(deps.MessageModel.rows).toHaveLength(0);
    expect(deps.ConversationModel.rows[0].lastMessageAt).toBeNull();
  });

  test("the cap is 1000 characters: 1000 is fine, 1001 is refused, not cut", async () => {
    const { conversation } = await start();
    await expect(say(ann, conversation._id, "x".repeat(LIMITS.body))).resolves.toBeTruthy();
    await expect(
      say(ann, conversation._id, "x".repeat(LIMITS.body + 1)),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(deps.MessageModel.rows).toHaveLength(1);
  });

  test("not while the other person's account is suspended", async () => {
    const { conversation } = await start();
    deps.UserModel.rows.find((u) => u._id === HAL).status = "suspended";
    await expect(say(ann, conversation._id, "hi")).rejects.toBeInstanceOf(ConflictError);
    expect(deps.MessageModel.rows).toHaveLength(0);
  });

  test("not by a suspended participant", async () => {
    const { conversation } = await start();
    await expect(
      say(person(ANN, "ann", { status: "suspended" }), conversation._id, "hi"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("thread", () => {
  async function talk(n) {
    const { conversation } = await start();
    for (let i = 1; i <= n; i += 1) {
      await say(i % 2 ? ann : hal, conversation._id, `Message ${i}`);
    }
    return conversation._id;
  }

  test("oldest first, with who wrote what, and it resets only the reader's counter", async () => {
    const cid = await talk(3); // ann, hal, ann
    expect(deps.ConversationModel.rows[0].unread).toEqual({ guest: 1, host: 2 });
    const asHost = await service.thread(deps, hal, cid);
    expect(asHost.messages.map((m) => m.body)).toEqual(["Message 1", "Message 2", "Message 3"]);
    expect(asHost.messages.map((m) => m.mine)).toEqual([false, true, false]);
    expect(asHost.conversation).toMatchObject({
      side: "host",
      otherName: "ann",
      listingTitle: "Sea house",
      canReply: true,
      reservationId: null,
    });
    expect(deps.ConversationModel.rows[0].unread).toEqual({ guest: 1, host: 0 });
    await service.thread(deps, ann, cid);
    expect(deps.ConversationModel.rows[0].unread).toEqual({ guest: 0, host: 0 });
  });

  test("an outsider and an admin get a 404 and change nothing", async () => {
    const cid = await talk(2);
    const before = JSON.stringify(deps.ConversationModel.rows);
    for (const user of [eve, root]) {
      await expect(service.thread(deps, user, cid)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(JSON.stringify(deps.ConversationModel.rows)).toBe(before);
  });

  test("pages of 50, newest page first, older ones through `before`", async () => {
    const cid = await talk(PAGE_SIZE * 2 + 20);
    const p1 = await service.thread(deps, ann, cid);
    expect(p1.messages).toHaveLength(PAGE_SIZE);
    expect(p1.messages[PAGE_SIZE - 1].body).toBe(`Message ${PAGE_SIZE * 2 + 20}`);
    expect(p1.messages[0].body).toBe(`Message ${PAGE_SIZE + 21}`);
    expect(p1.hasMore).toBe(true);
    const p2 = await service.thread(deps, ann, cid, { before: p1.nextBefore });
    expect(p2.messages[PAGE_SIZE - 1].body).toBe(`Message ${PAGE_SIZE + 20}`);
    expect(p2.hasMore).toBe(true);
    const p3 = await service.thread(deps, ann, cid, { before: p2.nextBefore });
    expect(p3.messages).toHaveLength(20);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextBefore).toBeNull();
  });

  test("a junk `before` is ignored (the newest page)", async () => {
    const cid = await talk(2);
    const r = await service.thread(deps, ann, cid, { before: "{$gt:1}" });
    expect(r.messages).toHaveLength(2);
  });

  test("canReply is false while the other account is suspended", async () => {
    const cid = await talk(1);
    deps.UserModel.rows.find((u) => u._id === HAL).status = "suspended";
    const r = await service.thread(deps, ann, cid);
    expect(r.conversation.canReply).toBe(false);
  });

  test("a booking-bound thread says which booking", async () => {
    const { conversation } = await service.startForReservation(deps, ann, BOOKING);
    const r = await service.thread(deps, hal, conversation._id);
    expect(r.conversation.reservationId).toBe(BOOKING);
  });
});

describe("listFor", () => {
  test("lists only the member's own conversations that have messages, newest first, with their unread count", async () => {
    const a = await start(ann);
    await start(ann, SAMS_LISTING).catch(() => undefined); // refused: nothing
    const b = await start(eve);
    const zed = person(id(6), "zed");
    deps.UserModel.rows.push(zed);
    await start(zed); // never writes: not listed
    await say(ann, a.conversation._id, "From ann");
    clockNow = new Date("2026-10-24T13:00:00Z");
    await say(eve, b.conversation._id, "From eve");
    clockNow = new Date("2026-10-24T14:00:00Z");
    await say(ann, a.conversation._id, "Ann again");

    const forHal = await service.listFor(deps, hal);
    expect(forHal.conversations.map((c) => c.preview)).toEqual(["Ann again", "From eve"]);
    expect(forHal.conversations.map((c) => c.unread)).toEqual([2, 1]);
    expect(forHal.conversations[0]).toMatchObject({
      side: "host",
      otherName: "ann",
      listingTitle: "Sea house",
      lastFromMe: false,
    });
    const forAnn = await service.listFor(deps, ann);
    expect(forAnn.conversations).toHaveLength(1);
    expect(forAnn.conversations[0]).toMatchObject({ side: "guest", otherName: "hal", unread: 0, lastFromMe: true });
    expect((await service.listFor(deps, root)).conversations).toEqual([]);
  });

  test("pages of 20; a page past the end shows the last, junk shows the first", async () => {
    for (let i = 0; i < LIST_SIZE + 5; i += 1) {
      const guest = person(id(100 + i), `g${i}`);
      deps.UserModel.rows.push(guest);
      const { conversation } = await start(guest);
      await say(guest, conversation._id, `Hello ${i}`);
    }
    const first = await service.listFor(deps, hal);
    expect(first.conversations).toHaveLength(LIST_SIZE);
    expect(first.totalPages).toBe(2);
    expect((await service.listFor(deps, hal, { page: "2" })).conversations).toHaveLength(5);
    expect((await service.listFor(deps, hal, { page: "99" })).page).toBe(2);
    expect((await service.listFor(deps, hal, { page: "x; drop" })).page).toBe(1);
  });
});
