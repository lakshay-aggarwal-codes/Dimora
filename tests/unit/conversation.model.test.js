// P11-T02: the Conversation and Message schemas (validation and indexes, no database).
const Conversation = require("../../src/models/conversation");
const Message = require("../../src/models/message");
const { LIMITS } = require("../../src/config/conversations");

const ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const errorsOf = (doc) => {
  const err = doc.validateSync();
  return err ? Object.keys(err.errors) : [];
};

describe("Conversation", () => {
  const valid = () => ({ threadKey: `listing:${ID}:${ID}`, listing: ID, guest: ID, host: ID });

  test("a minimal conversation is valid; counters start at 0 and it has no last message", () => {
    const c = new Conversation(valid());
    expect(c.validateSync()).toBeUndefined();
    expect(c.unread.guest).toBe(0);
    expect(c.unread.host).toBe(0);
    expect(c.lastMessageAt).toBeNull();
    expect(c.reservation).toBeNull();
  });

  test("threadKey, listing, guest and host are required", () => {
    expect(errorsOf(new Conversation({}))).toEqual(
      expect.arrayContaining(["threadKey", "listing", "guest", "host"]),
    );
  });

  test("an unread counter cannot be negative", () => {
    expect(errorsOf(new Conversation({ ...valid(), unread: { guest: -1 } }))).toContain("unread.guest");
  });

  test("threadKey is unique, and each side's list is indexed by last message", () => {
    const indexes = Conversation.schema.indexes();
    const unique = indexes.find(([key]) => key.threadKey === 1);
    expect(unique[1].unique).toBe(true);
    expect(indexes.some(([key]) => key.guest === 1 && key.lastMessageAt === -1)).toBe(true);
    expect(indexes.some(([key]) => key.host === 1 && key.lastMessageAt === -1)).toBe(true);
  });
});

describe("Message", () => {
  test("conversation, sender and body are required; the body has the cap", () => {
    expect(errorsOf(new Message({}))).toEqual(
      expect.arrayContaining(["conversation", "sender", "body"]),
    );
    expect(errorsOf(new Message({ conversation: ID, sender: ID, body: "x".repeat(LIMITS.body) }))).toEqual([]);
    expect(
      errorsOf(new Message({ conversation: ID, sender: ID, body: "x".repeat(LIMITS.body + 1) })),
    ).toContain("body");
  });

  test("createdAt only, and the thread is indexed by (conversation, _id)", () => {
    expect(Message.schema.path("updatedAt")).toBeUndefined();
    expect(
      Message.schema.indexes().some(([key]) => key.conversation === 1 && key._id === -1),
    ).toBe(true);
  });
});
