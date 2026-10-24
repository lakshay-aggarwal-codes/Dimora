// P11-T01: /notifications, the mark-read forms and GET /api/notifications/count
// through the real routers, controller, service and EJS views (layout
// included), with the Notification model replaced by an in-memory fake (no
// database). The last block runs the whole app (createApp) for the signed-out
// answers, which never reach the database.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Notification = require("../../src/models/notification");
const notificationsRouter = require("../../src/routes/notifications");
const apiRouter = require("../../src/routes/api");
const { createErrorHandler } = require("../../src/middleware/errors");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");
const { createAgent } = require("../helpers/agent");
const { fakeNotificationModel } = require("../helpers/fakeNotificationModel");
const service = require("../../src/services/notifications");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const person = (extra = {}) => ({
  _id: new ObjectId(),
  username: "someone",
  role: "member",
  status: "active",
  ...extra,
});
const ann = person({ username: "ann" });
const ben = person({ username: "ben" });

let Model;
let flashes;

function stubModel() {
  Model = fakeNotificationModel();
  for (const name of [
    "create",
    "countDocuments",
    "find",
    "updateOne",
    "updateMany",
    "exists",
  ]) {
    jest.spyOn(Notification, name).mockImplementation(Model[name]);
  }
}

function app(user) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  Object.assign(a.locals, {
    fullTitle,
    metaDescription,
    pagination,
    hiddenFields,
    listingsUrl,
    imageUrl: (u) => u,
  });
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
      success: [],
      error: [],
      currUser: user,
      currentPath: req.path,
      formatMoney,
      mapPublicToken: "",
      csrfToken: "t",
      cspNonce: "n",
    });
    res.locals.can = (action, resource) => can(action, user, resource);
    next();
  });
  a.use("/api", apiRouter);
  a.use("/", notificationsRouter);
  a.use(createErrorHandler({ isProduction: false, logger: null }));
  return a;
}

const give = (user, title, over = {}) =>
  service.notify(
    user._id,
    "reservation.requested",
    { kind: "reservation", id: new ObjectId() },
    { title, ...over },
  );

beforeEach(() => {
  flashes = [];
  stubModel();
});

describe("GET /api/notifications/count", () => {
  test("signed out: 401 JSON, and nothing is counted", async () => {
    const res = await request(app(undefined)).get("/api/notifications/count");
    expect(res.status).toBe(401);
    expect(res.type).toMatch(/json/);
    expect(res.body.error.code).toBe("unauthenticated");
    expect(Model.filters).toHaveLength(0);
  });

  test("signed in: the member's own unread count, never cached", async () => {
    await give(ann, "One");
    await give(ann, "Two");
    await give(ben, "Not yours");
    const res = await request(app(ann)).get("/api/notifications/count");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 2 });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Model.filters.every((f) => String(f.user) === String(ann._id))).toBe(
      true,
    );
  });

  test("a user id in the query string is ignored", async () => {
    await give(ben, "Ben's");
    const res = await request(app(ann)).get(
      `/api/notifications/count?user=${ben._id}`,
    );
    expect(res.body).toEqual({ unread: 0 });
  });
});

describe("GET /notifications", () => {
  test("signed out: a redirect to log in", async () => {
    const res = await request(app(undefined)).get("/notifications");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test("an empty inbox says so", async () => {
    const res = await request(app(ann)).get("/notifications");
    expect(res.status).toBe(200);
    expect(res.text).toContain("No notifications yet");
    expect(res.text).not.toContain("Mark all as read");
  });

  test("lists only the member's own, unread marked in words, text escaped", async () => {
    const mine = await give(ann, "Sea <b>house</b> request", {
      body: "A <script>alert(1)</script> guest",
      url: "/trips",
    });
    await give(ann, "Older, already read");
    await service.markRead(ann._id, Model.rows[1]._id);
    await give(ben, "Ben's secret");
    const res = await request(app(ann)).get("/notifications");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt; request");
    expect(res.text).not.toContain("<b>house</b>");
    expect(res.text).toContain("A &lt;script&gt;alert(1)&lt;/script&gt; guest");
    expect(res.text).not.toContain("<script>alert(1)");
    expect(res.text).not.toContain("Ben's secret");
    expect(res.text).toContain('<a href="/trips">');
    // Unread is a word, not only an edge colour; the read one has none.
    expect(res.text.match(/>Unread<\/span>/g)).toHaveLength(1);
    expect(res.text).toContain(`action="/notifications/${mine._id}/read"`);
    expect(res.text).toContain('action="/notifications/read-all"');
    expect(res.text).toContain('name="_csrf"');
    expect(res.text).toContain("Mark as read");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("a stored link that is not a same-site path is not printed as a link", async () => {
    await give(ann, "Tampered");
    Model.rows[0].url = "javascript:alert(1)";
    const res = await request(app(ann)).get("/notifications");
    expect(res.text).toContain("Tampered");
    expect(res.text).not.toContain("javascript:");
  });

  test("?show=unread lists only unread ones; with none left it says so", async () => {
    await give(ann, "Read one");
    await service.markRead(ann._id, Model.rows[0]._id);
    const res = await request(app(ann)).get("/notifications?show=unread");
    expect(res.status).toBe(200);
    expect(res.text).toContain("You are all caught up");
    expect(res.text).not.toContain("Read one");
    expect(res.text).toMatch(/aria-current="page">Unread/);
  });

  test("pages of 20 with links that keep the filter", async () => {
    for (let i = 1; i <= 45; i += 1) await give(ann, `Message ${i}`);
    const page1 = await request(app(ann)).get("/notifications?show=unread");
    expect(page1.text).toMatch(/Message 45\b/);
    expect(page1.text).toMatch(/Message 26\b/);
    expect(page1.text).not.toMatch(/Message 25\b/);
    expect(page1.text).toContain('href="/notifications?show=unread&amp;page=2"');
    const page3 = await request(app(ann)).get(
      "/notifications?show=unread&page=3",
    );
    expect(page3.text).toMatch(/Message 5\b/);
    expect(page3.text).not.toMatch(/Message 6\b/);
  });

  test("junk in the query never reaches the database as an operator", async () => {
    await give(ann, "Fine");
    const res = await request(app(ann)).get(
      "/notifications?show[$ne]=x&page[$gt]=1",
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("Fine");
  });
});

describe("POST /notifications/:id/read", () => {
  test("marks the member's notification read and returns to the list", async () => {
    const n = await give(ann, "Mine");
    const res = await request(app(ann))
      .post(`/notifications/${n._id}/read`)
      .type("form")
      .send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/notifications");
    expect(Model.rows[0].readAt).toBeInstanceOf(Date);
    expect(Model.rows[0].deleteAfter).toBeInstanceOf(Date);
  });

  test("returns to the same filter and page, and only to those", async () => {
    const n = await give(ann, "Mine");
    const res = await request(app(ann))
      .post(`/notifications/${n._id}/read`)
      .type("form")
      .send({ show: "unread", page: "2", next: "https://evil.example/" });
    expect(res.headers.location).toBe("/notifications?show=unread&page=2");
    const bad = await request(app(ann))
      .post(`/notifications/${n._id}/read`)
      .type("form")
      .send({ show: "x", page: "2; drop" });
    expect(bad.headers.location).toBe("/notifications");
  });

  test("someone else's notification: 404, unchanged", async () => {
    const theirs = await give(ben, "Ben's");
    const res = await request(app(ann))
      .post(`/notifications/${theirs._id}/read`)
      .type("form")
      .send({});
    expect(res.status).toBe(404);
    expect(Model.rows[0].readAt).toBeNull();
  });

  test("a malformed or unknown id is a 404 too", async () => {
    const a = app(ann);
    expect(
      (await request(a).post("/notifications/nope/read").type("form").send({}))
        .status,
    ).toBe(404);
    expect(
      (
        await request(a)
          .post(`/notifications/${new ObjectId()}/read`)
          .type("form")
          .send({})
      ).status,
    ).toBe(404);
  });

  test("signed out: a redirect to log in and nothing changes", async () => {
    const n = await give(ann, "Mine");
    const res = await request(app(undefined))
      .post(`/notifications/${n._id}/read`)
      .type("form")
      .send({});
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
    expect(Model.rows[0].readAt).toBeNull();
  });
});

describe("POST /notifications/read-all", () => {
  test("marks only the member's unread ones and says so", async () => {
    await give(ann, "A1");
    await give(ann, "A2");
    await give(ben, "B1");
    const res = await request(app(ann))
      .post("/notifications/read-all")
      .type("form")
      .send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/notifications");
    expect(Model.rows.map((r) => Boolean(r.readAt))).toEqual([true, true, false]);
    expect(flashes).toEqual([["success", "All notifications marked as read."]]);
  });

  test("nothing to mark: no message", async () => {
    await request(app(ann)).post("/notifications/read-all").type("form").send({});
    expect(flashes).toEqual([]);
  });

  test("signed out: a redirect to log in", async () => {
    const res = await request(app(undefined))
      .post("/notifications/read-all")
      .type("form")
      .send({});
    expect(res.headers.location).toMatch(/\/login/);
  });
});

describe("the whole app (signed out)", () => {
  test("/notifications sends a visitor to the login page", async () => {
    const res = await createAgent().get("/notifications");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe("/login");
  });

  test("the count endpoint answers a visitor with 401 JSON", async () => {
    const res = await createAgent().get("/api/notifications/count");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  test("a visitor's POST goes to the login page too (CSRF token supplied by the helper)", async () => {
    const res = await createAgent().post("/notifications/read-all");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe("/login");
  });

  test("POST without a CSRF token is refused", async () => {
    const res = await createAgent({ csrf: false }).post(
      "/notifications/read-all",
    );
    expect(res.status).toBe(403);
  });

  test("the visitor's navbar has no bell and loads no notification script", async () => {
    const res = await createAgent().get("/login");
    expect(res.text).not.toContain("data-notifications-bell");
    expect(res.text).not.toContain("/js/notifications.js");
  });
});
