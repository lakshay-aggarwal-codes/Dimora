// P12-T04: the report form, sending, and "Your reports" through the real
// router, controller, service and EJS views (layout included), in a small
// Express app with the models stubbed (no database). The real app is used for
// the mount, CSRF and rate-limit checks.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const User = require("../../src/models/user");
const Report = require("../../src/models/report");
const reportsRouter = require("../../src/routes/reports");
const { can } = require("../../src/policies");
const { createAuthLimiters } = require("../../src/middleware/security");
const { AppError } = require("../../src/utils/errors");
const { createAgent } = require("../helpers/agent");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const { formatMoney } = require("../../src/utils/money");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const me = {
  _id: new ObjectId(),
  username: "me",
  role: "member",
  status: "active",
};
const host = {
  _id: new ObjectId(),
  username: "asha",
  displayName: "Asha <b>K</b>",
  status: "active",
};
const listing = {
  _id: new ObjectId(),
  title: "Sea <i>house</i>",
  owner: host._id,
  status: "published",
  deletedAt: null,
};
const review = { _id: new ObjectId(), author: new ObjectId() };

function app(user, flashes = []) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  Object.assign(a.locals, {
    fullTitle,
    metaDescription,
    formatMoney,
    imageUrl: (u) => u,
  });
  a.use(express.urlencoded({ extended: false }));
  a.use((req, res, next) => {
    req.user = user;
    req.isAuthenticated = () => Boolean(user);
    req.session = {};
    req.flash = (type, message) => {
      if (message) flashes.push([type, message]);
      return [];
    };
    Object.assign(res.locals, {
      success: [],
      error: [],
      currUser: user,
      currentPath: req.path,
      can: (action, resource) => can(action, user, resource),
      csrfToken: "tok",
      cspNonce: "n",
      mapPublicToken: "",
    });
    next();
  });
  a.use("/", reportsRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}

const chain = (value) => {
  const c = {
    select: () => c,
    sort: () => c,
    limit: () => c,
    lean: () => c,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return c;
};

function stubModels({ stored = [] } = {}) {
  jest
    .spyOn(Listing, "findById")
    .mockImplementation((id) =>
      chain(String(id) === String(listing._id) ? listing : null),
    );
  jest.spyOn(Listing, "findOne").mockImplementation(() => chain(listing));
  jest
    .spyOn(Review, "findById")
    .mockImplementation((id) =>
      chain(String(id) === String(review._id) ? review : null),
    );
  jest
    .spyOn(User, "findOne")
    .mockImplementation((f) =>
      chain(String(f._id) === String(host._id) ? host : null),
    );
  jest.spyOn(Report, "countDocuments").mockResolvedValue(0);
  jest.spyOn(Report, "exists").mockResolvedValue(null);
  const create = jest
    .spyOn(Report, "create")
    .mockImplementation(async (doc) => ({ _id: new ObjectId(), ...doc }));
  jest.spyOn(Report, "find").mockImplementation(() => chain(stored));
  return { create };
}

describe("GET /reports/new", () => {
  test("shows what is being reported (looked up by the server, escaped), the reasons, a CSRF token and the hidden pair", async () => {
    stubModels();
    const res = await request(app(me)).get(
      `/reports/new?kind=listing&id=${listing._id}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("Report listing");
    expect(res.text).toContain("Sea &lt;i&gt;house&lt;/i&gt;");
    expect(res.text).not.toContain("Sea <i>house</i>");
    expect(res.text).toContain('name="kind" value="listing"');
    expect(res.text).toContain(`name="id" value="${listing._id}"`);
    expect(res.text).toContain('name="_csrf" value="tok"');
    for (const value of [
      "spam",
      "scam",
      "inaccurate",
      "offensive",
      "unsafe",
      "privacy",
      "other",
    ]) {
      expect(res.text).toContain(
        `name="reason" id="reason-${value}" value="${value}"`,
      );
    }
    expect(res.text).toMatch(
      /<textarea[^>]*name="details"[^>]*maxlength="1000"/,
    );
    expect(res.text).toContain("not told who reported them");
    expect(res.text).toMatch(/<form method="POST" action="\/reports"/);
  });

  test("works for a review and for a member", async () => {
    stubModels();
    expect(
      (await request(app(me)).get(`/reports/new?kind=review&id=${review._id}`))
        .text,
    ).toContain("A review of Sea &lt;i&gt;house&lt;/i&gt;");
    const member = await request(app(me)).get(
      `/reports/new?kind=user&id=${host._id}`,
    );
    expect(member.text).toContain("Report member");
    expect(member.text).toContain("Asha &lt;b&gt;K&lt;/b&gt;");
  });

  test("your own listing is a 403; a missing or unseen thing a 404; a bad kind a 400; messages not yet", async () => {
    stubModels();
    expect(
      (
        await request(app({ ...me, _id: host._id })).get(
          `/reports/new?kind=listing&id=${listing._id}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app(me)).get(
          `/reports/new?kind=listing&id=${new ObjectId()}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(app(me)).get("/reports/new?kind=listing&id=nope")).status,
    ).toBe(404);
    expect(
      (
        await request(app(me)).get(
          `/reports/new?kind=booking&id=${listing._id}`,
        )
      ).status,
    ).toBe(400);
    expect((await request(app(me)).get("/reports/new")).status).toBe(400);
    const message = await request(app(me)).get(
      `/reports/new?kind=message&id=${new ObjectId()}`,
    );
    expect(message.status).toBe(400);
    expect(message.text).toContain("Messages cannot be reported yet");
  });

  test("a signed-out visitor is sent to log in", async () => {
    const res = await request(app(undefined)).get(
      `/reports/new?kind=listing&id=${listing._id}`,
    );
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });
});

describe("POST /reports", () => {
  const form = (over = {}) => ({
    kind: "listing",
    id: String(listing._id),
    reason: "spam",
    details: "",
    ...over,
  });

  test("stores the report with the member as reporter and goes to Your reports with a thank-you", async () => {
    const { create } = stubModels();
    const flashes = [];
    const res = await request(app(me, flashes))
      .post("/reports")
      .type("form")
      .send(form({ reason: "inaccurate", details: " Wrong photos " }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/reports");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        reporter: me._id,
        targetKind: "listing",
        targetId: String(listing._id),
        targetOwner: host._id,
        reason: "inaccurate",
        details: "Wrong photos",
      }),
    );
    expect(flashes[0]).toEqual([
      "success",
      expect.stringMatching(/Thank you.*received/),
    ]);
  });

  test("who is reporting comes from the session, never from the form", async () => {
    const { create } = stubModels();
    await request(app(me))
      .post("/reports")
      .type("form")
      .send({
        ...form(),
        reporter: String(host._id),
        status: "resolved",
        targetOwner: String(me._id),
        targetLabel: "Hacked",
      });
    const stored = create.mock.calls[0][0];
    expect(stored.reporter).toBe(me._id);
    expect(stored.status).toBeUndefined();
    expect(stored.targetOwner).toBe(host._id);
    // the label is the title as stored (views escape it), whitespace tidied
    expect(stored.targetLabel).toBe("Sea <i>house</i>");
  });

  test("a missing reason shows the form again (400) with what was typed and the message", async () => {
    const { create } = stubModels();
    const res = await request(app(me))
      .post("/reports")
      .type("form")
      .send(form({ reason: "", details: "I typed <this>" }));
    expect(res.status).toBe(400);
    expect(res.text).toContain("data-report-error");
    expect(res.text).toContain("Choose a reason for your report.");
    expect(res.text).toContain("I typed &lt;this&gt;");
    expect(create).not.toHaveBeenCalled();
  });

  test('"something else" without words shows the form again, keeping the choice', async () => {
    stubModels();
    const res = await request(app(me))
      .post("/reports")
      .type("form")
      .send(form({ reason: "other", details: "no" }));
    expect(res.status).toBe(400);
    expect(res.text).toContain("a little more");
    expect(res.text).toMatch(/id="reason-other"[^>]*checked/);
  });

  test("a report that is already open: back to Your reports with the explanation (nothing new stored)", async () => {
    stubModels();
    jest.spyOn(Report, "exists").mockResolvedValue({ _id: 1 });
    const flashes = [];
    const res = await request(app(me, flashes))
      .post("/reports")
      .type("form")
      .send(form());
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/reports");
    expect(flashes[0][0]).toBe("error");
    expect(flashes[0][1]).toMatch(/already have an open report/);
    expect(Report.create).not.toHaveBeenCalled();
  });

  test("the unique index wins when two requests pass the check together", async () => {
    stubModels();
    jest
      .spyOn(Report, "create")
      .mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));
    const flashes = [];
    const res = await request(app(me, flashes))
      .post("/reports")
      .type("form")
      .send(form());
    expect(res.status).toBe(302);
    expect(flashes[0][1]).toMatch(/already have an open report/);
  });

  test("your own listing: 403 and nothing stored", async () => {
    const { create } = stubModels();
    const res = await request(app({ ...me, _id: host._id }))
      .post("/reports")
      .type("form")
      .send(form());
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  test("the daily cap: 429 with its message", async () => {
    stubModels();
    jest.spyOn(Report, "countDocuments").mockResolvedValue(20);
    const res = await request(app(me))
      .post("/reports")
      .type("form")
      .send(form());
    expect(res.status).toBe(429);
    expect(res.text).toContain("try again tomorrow");
  });

  test("odd input never reaches the database: arrays, objects, unknown kinds", async () => {
    const { create } = stubModels();
    for (const body of [
      { kind: ["listing"], id: String(listing._id), reason: "spam" },
      { kind: "listing", id: { $gt: "" }, reason: "spam" },
      { kind: "listing", id: String(listing._id), reason: { $ne: "" } },
      {
        kind: "listing",
        id: String(listing._id),
        reason: "spam",
        details: ["a"],
      },
      { kind: "nope", id: String(listing._id), reason: "spam" },
    ]) {
      const res = await request(app(me))
        .post("/reports")
        .type("json")
        .send(body);
      expect([400, 404]).toContain(res.status);
    }
    expect(create).not.toHaveBeenCalled();
  });

  test("a signed-out visitor is sent to log in and nothing is stored", async () => {
    const { create } = stubModels();
    const res = await request(app(undefined))
      .post("/reports")
      .type("form")
      .send(form());
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("GET /reports (Your reports)", () => {
  test("lists the member's reports with each status in plain words, escaped", async () => {
    stubModels({
      stored: [
        {
          _id: new ObjectId(),
          targetKind: "listing",
          targetLabel: "Sea <b>house</b>",
          reason: "scam",
          status: "open",
          createdAt: new Date("2026-11-02T10:00:00Z"),
        },
        {
          _id: new ObjectId(),
          targetKind: "user",
          targetLabel: "Asha",
          reason: "offensive",
          status: "resolved",
          createdAt: new Date("2026-11-01T10:00:00Z"),
        },
        {
          _id: new ObjectId(),
          targetKind: "review",
          targetLabel: "A review of X",
          reason: "spam",
          status: "dismissed",
          createdAt: new Date("2026-10-31T10:00:00Z"),
        },
      ],
    });
    const res = await request(app(me)).get("/reports");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Your reports");
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).not.toContain("Sea <b>house</b>");
    expect(res.text).toMatch(/data-report-status="open">Received</);
    expect(res.text).toMatch(/data-report-status="resolved">Looked at</);
    expect(res.text).toMatch(/data-report-status="dismissed">Closed</);
    expect(res.text).toContain("Scam or fraud");
    expect(res.text).toContain("2026-11-02");
    // nothing about who looked at it or why
    expect(res.text).not.toMatch(/moderator|admin|resolutionNote/i);
  });

  test("an empty list says so", async () => {
    stubModels({ stored: [] });
    const res = await request(app(me)).get("/reports");
    expect(res.status).toBe(200);
    expect(res.text).toContain("You have not reported anything");
  });

  test("only the signed-in member's reports are asked for", async () => {
    stubModels();
    await request(app(me)).get("/reports");
    expect(Report.find).toHaveBeenCalledWith({ reporter: me._id });
  });

  test("a signed-out visitor is sent to log in", async () => {
    const res = await request(app(undefined)).get("/reports");
    expect([301, 302, 303]).toContain(res.status);
  });
});

describe("the report limiter (5 a minute per member)", () => {
  function limited() {
    const a = express();
    const limiters = createAuthLimiters();
    a.use((req, res, next) => {
      req.user = req.get("x-user") ? { _id: req.get("x-user") } : undefined;
      next();
    });
    a.post("/reports", limiters.report, (req, res) => res.status(204).end());
    // eslint-disable-next-line no-unused-vars
    a.use((err, req, res, next) =>
      res
        .status(err instanceof AppError ? err.statusCode : 500)
        .send(err.message),
    );
    return a;
  }
  test("the sixth report in a minute is a 429; another member is not affected", async () => {
    const a = limited();
    for (let i = 0; i < 5; i += 1)
      expect(
        (await request(a).post("/reports").set("x-user", "u1")).status,
      ).toBe(204);
    const sixth = await request(a).post("/reports").set("x-user", "u1");
    expect(sixth.status).toBe(429);
    expect(sixth.text).toContain("sending reports very quickly");
    expect((await request(a).post("/reports").set("x-user", "u2")).status).toBe(
      204,
    );
  });
});

describe("in the real app", () => {
  test("all three pages are mounted and need a login", async () => {
    for (const url of [
      "/reports",
      "/reports/new?kind=listing&id=" + listing._id,
    ]) {
      const res = await createAgent().get(url);
      expect([301, 302, 303]).toContain(res.status);
      expect(res.headers.location).toMatch(/^\/login/);
    }
    const post = await createAgent()
      .post("/reports")
      .type("form")
      .send({ kind: "listing", id: String(listing._id), reason: "spam" });
    expect([301, 302, 303]).toContain(post.status);
    expect(post.headers.location).toMatch(/^\/login/);
  });

  test("POST /reports without a CSRF token is a 403 (the global check, no exception)", async () => {
    const res = await createAgent({ csrf: false })
      .post("/reports")
      .type("form")
      .send({ kind: "listing", id: String(listing._id), reason: "spam" });
    expect(res.status).toBe(403);
  });
});
