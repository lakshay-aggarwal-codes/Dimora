// P14-T04 without a database: the real admin router, guard, audit wrapper and
// controller in a small Express app, with the services' models and the audit
// write stubbed. Shows the wiring: one audit row per accepted action, none for
// a refusal, only admins reach it, and the pages render with real EJS.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const audit = require("../../src/services/audit");
const reportQueue = require("../../src/services/reportModeration");
const reviewModeration = require("../../src/services/reviewModeration");
const adminRouter = require("../../src/routes/admin");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const boss = {
  _id: new ObjectId(),
  username: "boss",
  role: "admin",
  status: "active",
};
const member = {
  _id: new ObjectId(),
  username: "ann",
  role: "member",
  status: "active",
};

function setup(user = boss, { render = false } = {}) {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT, "views"));
  app.engine("ejs", ejsMate);
  Object.assign(app.locals, {
    fullTitle,
    metaDescription,
    pagination,
    hiddenFields,
    listingsUrl,
    imageUrl: (u) => u,
  });
  app.use(express.urlencoded({ extended: false }));
  const flashes = [];
  app.use((req, res, next) => {
    req.user = user;
    req.id = "req-1";
    req.flash = (type, message) => flashes.push([type, message]);
    Object.assign(res.locals, {
      success: [],
      error: [],
      currUser: user,
      currentPath: req.path,
      formatMoney,
      mapPublicToken: "",
      csrfToken: "tok",
      cspNonce: "n",
    });
    res.locals.can = (a, r) => can(a, user, r);
    if (!render) {
      res.render = (view, locals) =>
        res
          .status(200)
          .json({ view, locals: JSON.parse(JSON.stringify(locals)) });
    }
    next();
  });
  app.use("/admin", adminRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) =>
    res.status(err.statusCode || 500).send(err.message),
  );
  return { app, flashes };
}

function stubAudit() {
  return jest.spyOn(audit, "record").mockImplementation(async ({ req }) => {
    req.auditRecorded = (req.auditRecorded || 0) + 1;
  });
}

const reportId = new ObjectId();
const reviewId = new ObjectId();

describe("closing a report", () => {
  test.each([
    ["resolve", "report.resolve", "resolved"],
    ["dismiss", "report.dismiss", "dismissed"],
  ])(
    "%s: one audit row, back to the queue, a message",
    async (route, action, outcome) => {
      const record = stubAudit();
      const close = jest.spyOn(reportQueue, "closeReport").mockResolvedValue({
        report: { _id: reportId },
        outcome,
        note: "Looked into it.",
        closedOthers: 0,
        details: {
          outcome,
          targetKind: "review",
          targetId: "x",
          closedOthers: 0,
        },
      });
      const { app, flashes } = setup();
      const res = await request(app)
        .post(`/admin/reports/${reportId}/${route}`)
        .type("form")
        .send({ note: "Looked into it.", closeOthers: "1" });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/admin/reports");
      expect(close).toHaveBeenCalledWith(
        expect.objectContaining({
          id: String(reportId),
          outcome: route,
          note: "Looked into it.",
          closeOthers: true,
          admin: boss,
        }),
      );
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({
        action,
        targetType: "report",
        targetId: reportId,
        reason: "Looked into it.",
        details: { outcome },
      });
      expect(flashes[0][0]).toBe("success");
    },
  );

  test("the checkbox is the only way to close the others", async () => {
    stubAudit();
    const close = jest.spyOn(reportQueue, "closeReport").mockResolvedValue({
      report: { _id: reportId },
      outcome: "resolved",
      note: "n",
      closedOthers: 0,
      details: {},
    });
    const { app } = setup();
    for (const body of [
      { note: "Fine, done." },
      { note: "Fine, done.", closeOthers: "yes" },
      { note: "Fine, done.", closeOthers: "true" },
    ]) {
      await request(app)
        .post(`/admin/reports/${reportId}/resolve`)
        .type("form")
        .send(body);
    }
    expect(close.mock.calls.map((c) => c[0].closeOthers)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("a refusal goes back to the report with the message, and writes no audit row", async () => {
    const record = stubAudit();
    jest
      .spyOn(reportQueue, "closeReport")
      .mockRejectedValue(
        new reportQueue.ReportAdminError("This report was already closed."),
      );
    const { app, flashes } = setup();
    const res = await request(app)
      .post(`/admin/reports/${reportId}/resolve`)
      .type("form")
      .send({ note: "Done now." });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/reports/${reportId}`);
    expect(record).not.toHaveBeenCalled();
    expect(flashes[0]).toEqual(["error", "This report was already closed."]);
  });

  test("a malformed id goes back to the queue, not to a made-up path", async () => {
    stubAudit();
    jest
      .spyOn(reportQueue, "closeReport")
      .mockRejectedValue(
        new reportQueue.ReportAdminError("That report does not exist."),
      );
    const { app } = setup();
    const res = await request(app)
      .post("/admin/reports/..%2F..%2Fx/resolve")
      .type("form")
      .send({ note: "Whatever." });
    expect(res.headers.location).toBe("/admin/reports");
  });
});

describe("hiding and restoring a review", () => {
  test.each([
    ["hide", "review.hide", "reviewModeration.hideReview"],
    ["restore", "review.restore", "reviewModeration.restoreReview"],
  ])(
    "%s: one audit row, back to the report it came from",
    async (route, action) => {
      const record = stubAudit();
      const fn = route === "hide" ? "hideReview" : "restoreReview";
      const spy = jest.spyOn(reviewModeration, fn).mockResolvedValue({
        review: { _id: reviewId },
        reason: "Private details shown",
        details: { rating: 2, listingId: "l" },
      });
      const { app, flashes } = setup();
      const res = await request(app)
        .post(`/admin/reviews/${reviewId}/${route}`)
        .type("form")
        .send({ reason: "Private details shown", from: String(reportId) });
      expect(res.headers.location).toBe(`/admin/reports/${reportId}`);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: String(reviewId),
          reason: "Private details shown",
          admin: boss,
        }),
      );
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({
        action,
        targetType: "review",
        targetId: reviewId,
        reason: "Private details shown",
      });
      expect(flashes[0][0]).toBe("success");
    },
  );

  test.each([
    ["https://evil.example/x"],
    ["//evil.example"],
    ["/admin/users"],
    ["javascript:alert(1)"],
    [""],
    [undefined],
  ])(
    "the 'from' field %j can only ever lead to a report page or the queue",
    async (from) => {
      stubAudit();
      jest.spyOn(reviewModeration, "hideReview").mockResolvedValue({
        review: { _id: reviewId },
        reason: "A good reason",
        details: {},
      });
      const { app } = setup();
      const res = await request(app)
        .post(`/admin/reviews/${reviewId}/hide`)
        .type("form")
        .send({ reason: "A good reason", from });
      expect(res.headers.location).toBe("/admin/reports");
    },
  );

  test("a refusal (no reason, already hidden) writes no audit row", async () => {
    const record = stubAudit();
    jest
      .spyOn(reviewModeration, "hideReview")
      .mockRejectedValue(
        new reviewModeration.ReviewModerationError(
          "This review is already hidden.",
        ),
      );
    const { app, flashes } = setup();
    const res = await request(app)
      .post(`/admin/reviews/${reviewId}/hide`)
      .type("form")
      .send({ reason: "Again please", from: String(reportId) });
    expect(res.headers.location).toBe(`/admin/reports/${reportId}`);
    expect(record).not.toHaveBeenCalled();
    expect(flashes[0]).toEqual(["error", "This review is already hidden."]);
  });
});

describe("who can reach it", () => {
  test.each([
    ["GET", "/admin/reports"],
    ["GET", `/admin/reports/${reportId}`],
    ["POST", `/admin/reports/${reportId}/resolve`],
    ["POST", `/admin/reports/${reportId}/dismiss`],
    ["POST", `/admin/reviews/${reviewId}/hide`],
    ["POST", `/admin/reviews/${reviewId}/restore`],
  ])(
    "a member gets the ordinary 404 for %s %s, and nothing runs",
    async (method, url) => {
      const record = stubAudit();
      const close = jest.spyOn(reportQueue, "closeReport");
      const hide = jest.spyOn(reviewModeration, "hideReview");
      const { app } = setup(member);
      const call =
        method === "GET" ? request(app).get(url) : request(app).post(url);
      const res = await call
        .type("form")
        .send({ note: "Please do it", reason: "Please do it" });
      expect(res.status).toBe(404);
      expect(record).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(hide).not.toHaveBeenCalled();
    },
  );

  test("a suspended admin and a visitor are refused too", async () => {
    for (const user of [{ ...boss, status: "suspended" }, null]) {
      const { app } = setup(user);
      expect((await request(app).get("/admin/reports")).status).toBe(404);
    }
  });
});

describe("the pages (real EJS, layout included)", () => {
  const listed = (rows, extra = {}) =>
    jest.spyOn(reportQueue, "listReports").mockResolvedValue({
      rows,
      page: 1,
      totalPages: 1,
      total: rows.length,
      status: "open",
      kind: "",
      openTotal: rows.length,
      ...extra,
    });

  test("the queue: tabs with the open count, kind filters, rows that link to their report", async () => {
    listed([
      {
        id: String(reportId),
        kind: "review",
        kindLabel: "Review",
        target: "A review of <b>Sea</b>",
        reasonLabel: "Spam or an advert",
        reporter: "ann",
        status: "open",
        createdAt: new Date("2026-10-01"),
        resolvedAt: null,
        openOnTarget: 3,
      },
    ]);
    const { app } = setup(boss, { render: true });
    const res = await request(app).get("/admin/reports");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Reports");
    expect(res.text).toMatch(
      /Open <span class="badge text-bg-light">1<\/span>/,
    );
    expect(res.text).toContain('href="/admin/reports?status=resolved"');
    expect(res.text).toContain(
      'href="/admin/reports?status=open&amp;kind=review"',
    );
    expect(res.text).toContain(`href="/admin/reports/${reportId}"`);
    expect(res.text).toContain("3 open reports about this");
    expect(res.text).toContain("A review of &lt;b&gt;Sea&lt;/b&gt;");
    expect(res.text).not.toContain("<b>Sea</b>");
  });

  test("an empty queue says so", async () => {
    listed([]);
    const { app } = setup(boss, { render: true });
    expect((await request(app).get("/admin/reports")).text).toContain(
      "No open reports",
    );
  });

  test("the query string reaches the service as plain text only", async () => {
    const list = listed([]);
    const { app } = setup(boss, { render: true });
    await request(app).get(
      "/admin/reports?status=resolved&kind=listing&page=2&kind=review",
    );
    expect(list).toHaveBeenCalledWith({
      status: "resolved",
      kind: undefined,
      page: "2",
    });
  });

  const pageFor = (target, extra = {}) => ({
    report: {
      id: String(reportId),
      kindLabel: "Review",
      reasonLabel: "Offensive, hateful or harassing",
      details: "Insults <i>me</i>",
      reporter: "ann",
      status: "open",
      createdAt: new Date("2026-10-01"),
      resolvedAt: null,
      resolvedBy: null,
      note: "",
      ...extra,
    },
    target,
    others: [
      {
        id: String(new ObjectId()),
        reasonLabel: "Spam or an advert",
        details: "",
        status: "open",
        reporter: "bob",
        createdAt: new Date(),
      },
    ],
    openOthers: 1,
  });
  const review = (extra = {}) => ({
    kind: "review",
    id: String(reviewId),
    rating: 1,
    comment: "Terrible <script>x()</script>",
    author: "guest1",
    listingTitle: "Sea house",
    hidden: false,
    hiddenReason: "",
    ...extra,
  });
  const showing = (page) =>
    jest.spyOn(reportQueue, "getReport").mockResolvedValue(page);

  test("an open report about a review: the text escaped, a hide form, and a close form with both outcomes and the 'also close' box", async () => {
    showing(pageFor(review()));
    const { app } = setup(boss, { render: true });
    const res = await request(app).get(`/admin/reports/${reportId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Terrible &lt;script&gt;x()&lt;/script&gt;");
    expect(res.text).not.toContain("<script>x()");
    expect(res.text).toContain("Insults &lt;i&gt;me&lt;/i&gt;");
    expect(res.text).toContain(`action="/admin/reviews/${reviewId}/hide"`);
    expect(res.text).toContain(`name="from" value="${reportId}"`);
    expect(res.text).toContain(`action="/admin/reports/${reportId}/resolve"`);
    expect(res.text).toContain(
      `formaction="/admin/reports/${reportId}/dismiss"`,
    );
    expect(res.text).toContain("Also close the 1 other open report");
    expect(
      (res.text.match(/name="_csrf" value="tok"/g) || []).length,
    ).toBeGreaterThanOrEqual(2);
    expect(res.text).not.toContain("/restore");
  });

  test("a hidden review offers restore, not hide", async () => {
    showing(pageFor(review({ hidden: true, hiddenReason: "Private data" })));
    const { app } = setup(boss, { render: true });
    const res = await request(app).get(`/admin/reports/${reportId}`);
    expect(res.text).toContain("data-review-hidden");
    expect(res.text).toContain(`action="/admin/reviews/${reviewId}/restore"`);
    expect(res.text).not.toContain(`/admin/reviews/${reviewId}/hide`);
  });

  test("a closed report shows its outcome and has no close form", async () => {
    showing(
      pageFor(review(), {
        status: "dismissed",
        resolvedAt: new Date("2026-10-02"),
        resolvedBy: "boss",
        note: "Nothing wrong.",
      }),
    );
    const { app } = setup(boss, { render: true });
    const res = await request(app).get(`/admin/reports/${reportId}`);
    expect(res.text).toContain("dismissed by boss");
    expect(res.text).toContain("Nothing wrong.");
    expect(res.text).not.toContain("close-form");
  });

  test.each([
    [{ kind: "message", unavailable: true }, "data-target-unavailable"],
    [{ kind: "review", gone: true }, "data-target-gone"],
    [
      {
        kind: "listing",
        title: "Sea house",
        status: "suspended",
        url: "/admin/listings/x",
      },
      "/admin/listings/x",
    ],
    [
      {
        kind: "user",
        username: "spammer",
        status: "active",
        url: "/admin/users/y",
      },
      "/admin/users/y",
    ],
  ])("the reported thing %j", async (target, expected) => {
    showing(pageFor(target));
    const { app } = setup(boss, { render: true });
    const res = await request(app).get(`/admin/reports/${reportId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(expected);
  });

  test("a report that does not exist is a 404", async () => {
    jest.spyOn(reportQueue, "getReport").mockResolvedValue(null);
    const { app } = setup(boss, { render: true });
    expect((await request(app).get(`/admin/reports/${reportId}`)).status).toBe(
      404,
    );
  });

  test("the admin landing page links to the queue", async () => {
    const { app } = setup(boss, { render: true });
    expect((await request(app).get("/admin")).text).toContain(
      'href="/admin/reports"',
    );
  });
});
