// P11-T02: the messaging endpoints and pages through the real router,
// controller, service and EJS views (layout included), with the five models
// replaced by in-memory fakes (no database). The last block runs the whole app
// (createApp) for the signed-out answers and the rate limit, which never reach
// the database.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const Conversation = require("../../src/models/conversation");
const Message = require("../../src/models/message");
const Listing = require("../../src/models/listing");
const Reservation = require("../../src/models/reservation");
const User = require("../../src/models/user");
const conversationsRouter = require("../../src/routes/conversations");
const { createErrorHandler } = require("../../src/middleware/errors");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");
const { createAgent } = require("../helpers/agent");
const { fakeCollection } = require("../helpers/fakeCollection");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const id = (n) => String(n).padStart(24, "0");
const person = (_id, username, extra = {}) => ({
  _id,
  username,
  displayName: username,
  role: "member",
  status: "active",
  ...extra,
});
const ann = person(id(1), "ann"); // guest
const hal = person(id(2), "hal"); // host
const eve = person(id(3), "eve"); // outsider
const root = person(id(4), "root", { role: "admin" });
const LISTING = id(10);
const DRAFT = id(11);
const BOOKING = id(20);

let db;
let flashes;

function stub() {
  db = {
    Conversation: fakeCollection({
      uniqueKey: "threadKey",
      defaults: () => ({ unread: { guest: 0, host: 0 }, lastMessageAt: null, reservation: null }),
    }),
    Message: fakeCollection(),
    User: fakeCollection().seed(ann, hal, eve, root),
    Listing: fakeCollection().seed(
      { _id: LISTING, owner: hal._id, status: "published", deletedAt: null, title: "Sea <b>house</b>" },
      { _id: DRAFT, owner: hal._id, status: "draft", deletedAt: null, title: "Draft" },
    ),
    Reservation: fakeCollection().seed({ _id: BOOKING, listing: LISTING, guest: ann._id, host: hal._id }),
  };
  const models = { Conversation, Message, Listing, Reservation, User };
  const names = ["find", "findOne", "findById", "create", "countDocuments", "updateOne"];
  for (const [key, model] of Object.entries(models)) {
    for (const name of names) {
      if (db[key][name]) jest.spyOn(model, name).mockImplementation(db[key][name]);
    }
  }
}

function app(user) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  Object.assign(a.locals, { fullTitle, metaDescription, pagination, hiddenFields, listingsUrl, imageUrl: (u) => u });
  a.use(express.urlencoded({ extended: true }));
  a.use((req, res, next) => {
    req.user = user;
    req.isAuthenticated = () => Boolean(user);
    req.session = {};
    req.flash = (kind, text) => {
      if (text) flashes.push([kind, text]);
      return [];
    };
    Object.assign(res.locals, {
      success: [], error: [], currUser: user, currentPath: req.path, formatMoney,
      mapPublicToken: "", csrfToken: "t", cspNonce: "n",
    });
    res.locals.can = (action, resource) => can(action, user, resource);
    next();
  });
  a.use("/", conversationsRouter);
  a.use(createErrorHandler({ isProduction: false, logger: null }));
  return a;
}

beforeEach(() => {
  flashes = [];
  stub();
});

const open = async (user = ann) =>
  (await request(app(user)).post(`/api/listings/${LISTING}/conversations`).type("form").send({})).body.conversation.id;
const post = (user, cid, body) =>
  request(app(user)).post(`/api/conversations/${cid}/messages`).type("form").send({ body });

describe("JSON: starting a conversation", () => {
  test("signed out: 401 JSON", async () => {
    const res = await request(app(undefined)).post(`/api/listings/${LISTING}/conversations`).type("form").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  test("201 the first time, 200 after, same id and a page link", async () => {
    const first = await request(app(ann)).post(`/api/listings/${LISTING}/conversations`).type("form").send({});
    expect(first.status).toBe(201);
    expect(first.body.conversation.url).toBe(`/conversations/${first.body.conversation.id}`);
    expect(first.headers["cache-control"]).toBe("no-store");
    const again = await request(app(ann)).post(`/api/listings/${LISTING}/conversations`).type("form").send({});
    expect(again.status).toBe(200);
    expect(again.body.conversation.id).toBe(first.body.conversation.id);
    expect(db.Conversation.rows).toHaveLength(1);
  });

  test("your own listing: 403; a draft or unknown listing: 404; a suspended host: 409", async () => {
    const own = await request(app(hal)).post(`/api/listings/${LISTING}/conversations`).type("form").send({});
    expect(own.status).toBe(403);
    const draft = await request(app(ann)).post(`/api/listings/${DRAFT}/conversations`).type("form").send({});
    expect(draft.status).toBe(404);
    const junk = await request(app(ann)).post("/api/listings/nope/conversations").type("form").send({});
    expect(junk.status).toBe(404);
    db.User.rows.find((u) => u._id === hal._id).status = "suspended";
    const suspended = await request(app(ann)).post(`/api/listings/${LISTING}/conversations`).type("form").send({});
    expect(suspended.status).toBe(409);
    expect(db.Conversation.rows).toHaveLength(0);
  });

  test("a booking's conversation: its guest and host open the same one, others get 404", async () => {
    const a = await request(app(ann)).post(`/api/reservations/${BOOKING}/conversation`).type("form").send({});
    const b = await request(app(hal)).post(`/api/reservations/${BOOKING}/conversation`).type("form").send({});
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.conversation.id).toBe(a.body.conversation.id);
    for (const user of [eve, root]) {
      const res = await request(app(user)).post(`/api/reservations/${BOOKING}/conversation`).type("form").send({});
      expect(res.status).toBe(404);
    }
  });
});

describe("JSON: sending and reading", () => {
  test("a message is stored, 201, and only the other side's unread count rises", async () => {
    const cid = await open();
    const res = await post(ann, cid, "Is the cot free?");
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ body: "Is the cot free?", mine: true });
    expect(db.Conversation.rows[0].unread).toEqual({ guest: 0, host: 1 });
    await post(hal, cid, "Yes.");
    expect(db.Conversation.rows[0].unread).toEqual({ guest: 1, host: 1 });
  });

  test("outsiders and admins: 404 for reading and for writing, nothing stored", async () => {
    const cid = await open();
    for (const user of [eve, root]) {
      expect((await post(user, cid, "hi")).status).toBe(404);
      expect((await request(app(user)).get(`/api/conversations/${cid}/messages`)).status).toBe(404);
    }
    expect(db.Message.rows).toHaveLength(0);
  });

  test("an empty, missing or over-long message is a 400 with a readable message", async () => {
    const cid = await open();
    const empty = await post(ann, cid, "   ");
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toMatch(/Write a message/);
    const missing = await request(app(ann)).post(`/api/conversations/${cid}/messages`).type("form").send({});
    expect(missing.status).toBe(400);
    const long = await post(ann, cid, "x".repeat(1001));
    expect(long.status).toBe(400);
    expect(long.body.error.message).toMatch(/1000/);
    expect(db.Message.rows).toHaveLength(0);
  });

  test("reading returns the thread, marks the reader's side read, and is never cached", async () => {
    const cid = await open();
    await post(ann, cid, "One");
    await post(ann, cid, "Two");
    const res = await request(app(hal)).get(`/api/conversations/${cid}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m) => m.body)).toEqual(["One", "Two"]);
    expect(res.body.messages.every((m) => m.mine === false)).toBe(true);
    expect(res.body.conversation).toMatchObject({ side: "host", otherName: "ann", canReply: true });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(db.Conversation.rows[0].unread).toEqual({ guest: 0, host: 0 });
  });

  test("the list: only my conversations that have messages, with my unread count", async () => {
    const cid = await open();
    const none = await request(app(hal)).get("/api/conversations");
    expect(none.body.conversations).toEqual([]); // nobody has written yet
    await post(ann, cid, "Hello");
    const forHal = await request(app(hal)).get("/api/conversations");
    expect(forHal.body.conversations).toHaveLength(1);
    expect(forHal.body.conversations[0]).toMatchObject({ id: cid, unread: 1, preview: "Hello", otherName: "ann" });
    expect((await request(app(eve)).get("/api/conversations")).body.conversations).toEqual([]);
  });

  test("signed out: 401 JSON for every endpoint", async () => {
    const cid = await open();
    const anon = app(undefined);
    for (const res of [
      await request(anon).get("/api/conversations"),
      await request(anon).get(`/api/conversations/${cid}/messages`),
      await request(anon).post(`/api/conversations/${cid}/messages`).type("form").send({ body: "x" }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.type).toMatch(/json/);
    }
    expect(db.Message.rows).toHaveLength(0);
  });
});

describe("pages", () => {
  test("Contact host: signed out goes to the login page", async () => {
    const res = await request(app(undefined)).post(`/listings/${LISTING}/contact`).type("form").send({});
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
    expect(db.Conversation.rows).toHaveLength(0);
  });

  test("Contact host: creates the conversation and opens it; the host's own listing is a 403", async () => {
    const res = await request(app(ann)).post(`/listings/${LISTING}/contact`).type("form").send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/conversations/${db.Conversation.rows[0]._id}`);
    const own = await request(app(hal)).post(`/listings/${LISTING}/contact`).type("form").send({});
    expect(own.status).toBe(403);
  });

  test("a message with markup is printed escaped, never as HTML", async () => {
    const cid = await open();
    const payload = `<script>alert(1)</script><img src=x onerror=alert(2)> & "quotes"`;
    await post(ann, cid, payload);
    for (const user of [ann, hal]) {
      const res = await request(app(user)).get(`/conversations/${cid}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(res.text).toContain("&lt;img src=x onerror=alert(2)&gt;");
      expect(res.text).not.toContain("<script>alert(1)");
      expect(res.text).not.toContain("<img src=x");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  test("the thread page names the people, escapes the listing title and has a reply form with a CSRF field", async () => {
    const cid = await open();
    await post(ann, cid, "Hello");
    const res = await request(app(hal)).get(`/conversations/${cid}`);
    expect(res.text).toContain("Conversation with ann");
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).not.toContain("<b>house</b>");
    expect(res.text).toContain(`action="/conversations/${cid}/messages"`);
    expect(res.text).toContain('name="_csrf"');
    expect(res.text).toContain('maxlength="1000"');
  });

  test("outsiders and admins get a 404 page; signed out goes to log in", async () => {
    const cid = await open();
    for (const user of [eve, root]) {
      expect((await request(app(user)).get(`/conversations/${cid}`)).status).toBe(404);
    }
    const anon = await request(app(undefined)).get(`/conversations/${cid}`);
    expect(anon.headers.location).toMatch(/\/login/);
  });

  test("the reply form sends, then returns to the thread; a bad message flashes and returns", async () => {
    const cid = await open();
    const ok = await request(app(ann)).post(`/conversations/${cid}/messages`).type("form").send({ body: "Hi" });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe(`/conversations/${cid}`);
    expect(db.Message.rows).toHaveLength(1);
    const bad = await request(app(ann)).post(`/conversations/${cid}/messages`).type("form").send({ body: "  " });
    expect(bad.headers.location).toBe(`/conversations/${cid}`);
    expect(flashes).toEqual([["error", "Write a message first."]]);
    expect(db.Message.rows).toHaveLength(1);
    const out = await request(app(eve)).post(`/conversations/${cid}/messages`).type("form").send({ body: "Hi" });
    expect(out.status).toBe(404);
  });

  test("while the other account is suspended the page offers no reply form", async () => {
    const cid = await open();
    db.User.rows.find((u) => u._id === hal._id).status = "suspended";
    const res = await request(app(ann)).get(`/conversations/${cid}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("You cannot send messages in this conversation right now.");
    expect(res.text).not.toContain(`action="/conversations/${cid}/messages"`);
  });
});

describe("the inbox page (P11-T03)", () => {
  const writeTo = async (guest, text, listing = LISTING) => {
    const res = await request(app(guest)).post(`/api/listings/${listing}/conversations`).type("form").send({});
    const cid = res.body.conversation.id;
    await post(guest, cid, text);
    return cid;
  };

  test("signed out goes to the login page", async () => {
    const res = await request(app(undefined)).get("/messages");
    expect(res.headers.location).toMatch(/\/login/);
  });

  test("an empty inbox says so and points to the listings", async () => {
    const res = await request(app(ann)).get("/messages");
    expect(res.status).toBe(200);
    expect(res.text).toContain("No messages yet");
    expect(res.text).toContain('href="/listings"');
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("a conversation nobody has written in is not listed", async () => {
    await open();
    const res = await request(app(hal)).get("/messages");
    expect(res.text).toContain("No messages yet");
  });

  test("lists my conversations with who, which listing, a preview, and unread in words", async () => {
    const cid = await writeTo(ann, "Is the <b>cot</b> free?");
    const forHost = await request(app(hal)).get("/messages");
    expect(forHost.status).toBe(200);
    expect(forHost.text).toContain(`href="/conversations/${cid}"`);
    expect(forHost.text).toContain("conversation-row conversation-unread");
    expect(forHost.text).toContain("1 unread");
    expect(forHost.text).toContain(">ann<");
    expect(forHost.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    // The preview is text: escaped, never HTML.
    expect(forHost.text).toContain("Is the &lt;b&gt;cot&lt;/b&gt; free?");
    expect(forHost.text).not.toContain("<b>cot</b>");
    // The sender sees their own message as read, prefixed "You:".
    const forGuest = await request(app(ann)).get("/messages");
    expect(forGuest.text).not.toContain("conversation-unread");
    expect(forGuest.text).not.toContain("unread</span>");
    expect(forGuest.text).toContain("You: ");
  });

  test("opening the thread clears the unread mark in the list", async () => {
    const cid = await writeTo(ann, "Hello");
    await request(app(hal)).get(`/conversations/${cid}`);
    const res = await request(app(hal)).get("/messages");
    expect(res.text).not.toContain("conversation-unread");
  });

  test("an outsider and an admin see none of it", async () => {
    await writeTo(ann, "Private");
    for (const user of [eve, root]) {
      const res = await request(app(user)).get("/messages");
      expect(res.text).toContain("No messages yet");
      expect(res.text).not.toContain("Private");
    }
  });

  test("pages of 20 with page links", async () => {
    for (let i = 0; i < 25; i += 1) {
      const guest = person(id(100 + i), `g${i}`);
      db.User.rows.push(guest);
      await writeTo(guest, `Hello ${i}`);
    }
    const first = await request(app(hal)).get("/messages");
    expect(first.text.match(/class="conversation-row/g)).toHaveLength(20);
    expect(first.text).toContain('href="/messages?page=2"');
    const second = await request(app(hal)).get("/messages?page=2");
    expect(second.text.match(/class="conversation-row/g)).toHaveLength(5);
  });
});

describe("the thread page keeps itself current (P11-T03)", () => {
  test("the newest page polls every 15 seconds and loads the script", async () => {
    const cid = await open();
    await post(ann, cid, "Hi");
    const res = await request(app(ann)).get(`/conversations/${cid}`);
    expect(res.text).toContain("data-message-list");
    expect(res.text).toContain(`data-messages-url="/api/conversations/${cid}/messages"`);
    expect(res.text).toContain('data-poll-seconds="15"');
    expect(res.text).toContain('role="log"');
    expect(res.text).toMatch(/<li class="message message-mine" data-id="[0-9a-f]{24}">/);
    expect(res.text).toContain('<script src="/js/conversation-thread.js"></script>');
    expect(res.text).toContain('href="/messages"');
  });

  test("an empty thread shows the hint, and the list is still there for polling", async () => {
    const cid = await open();
    const res = await request(app(ann)).get(`/conversations/${cid}`);
    expect(res.text).toMatch(/<p class="text-body-secondary" data-empty>No messages yet/);
    expect(res.text).toContain("data-message-list");
  });

  test("an older page (?before=) is not polled", async () => {
    const cid = await open();
    for (let i = 1; i <= 52; i += 1) await post(ann, cid, `M${i}`);
    const newest = await request(app(ann)).get(`/api/conversations/${cid}/messages`);
    const older = await request(app(ann)).get(`/conversations/${cid}?before=${newest.body.nextBefore}`);
    expect(older.status).toBe(200);
    expect(older.text).toContain("data-message-list");
    expect(older.text).not.toContain("data-messages-url");
    expect(older.text).not.toContain("data-poll-seconds");
  });
});

describe("the whole app", () => {
  test("pages send a visitor to log in; the API answers 401 JSON", async () => {
    const agent = createAgent();
    expect((await agent.get(`/conversations/${id(5)}`)).headers.location).toBe("/login");
    expect((await agent.post(`/listings/${LISTING}/contact`)).headers.location).toBe("/login");
    const api = await agent.get("/api/conversations");
    expect(api.status).toBe(401);
    expect(api.body.error.code).toBe("unauthenticated");
  });

  test("a POST without a CSRF token is refused", async () => {
    const res = await createAgent({ csrf: false }).post(`/api/conversations/${id(5)}/messages`);
    expect(res.status).toBe(403);
  });

  test("sending is rate limited: 20 a minute, then 429 JSON", async () => {
    const agent = createAgent();
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await agent.post(`/api/conversations/${id(5)}/messages`).type("form").send({ body: "x" });
      if (i < 20) expect(last.status).toBe(401);
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("rate_limited");
  });
});
