// P09-T02: /host/reservations through the real router, controller, service and
// EJS views (layout included), in a small Express app with the models stubbed
// (no database). Who is signed in is set by the test.
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Reservation = require("../../src/models/reservation");
const Listing = require("../../src/models/listing");
const reservationsService = require("../../src/services/reservations");
const hostRouter = require("../../src/routes/host");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");
const { ConflictError } = require("../../src/utils/errors");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const person = (extra = {}) => ({
  _id: new ObjectId(),
  username: "someone",
  role: "member",
  status: "active",
  ...extra,
});
const host = person({ username: "asha" });
const stranger = person({ username: "eve" });
const guestDoc = {
  _id: new ObjectId(),
  displayName: "Ravi <i>R</i>",
  username: "ravi",
  createdAt: new Date("2025-03-10T00:00:00Z"),
};
const NOW = Date.now();

function app(user, flashes = []) {
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
  a.use(express.urlencoded({ extended: false }));
  a.use((req, res, next) => {
    req.user = user;
    req.isAuthenticated = () => Boolean(user);
    req.session = {};
    req.flash = (type, message) => {
      if (message) flashes.push([type, message]);
      return [];
    };
    res.locals.success = [];
    res.locals.error = [];
    res.locals.currUser = user;
    res.locals.currentPath = req.path;
    res.locals.formatMoney = formatMoney;
    res.locals.can = (action, resource) => can(action, user, resource);
    res.locals.mapPublicToken = "";
    res.locals.csrfToken = "tok";
    res.locals.cspNonce = "n";
    next();
  });
  a.use("/host", hostRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}

function row(extra = {}) {
  return {
    _id: new ObjectId(),
    guest: guestDoc,
    host: host._id,
    status: "pending",
    holdExpiresAt: new Date(NOW + 5 * 3600000),
    checkIn: new Date("2026-12-01T00:00:00Z"),
    checkOut: new Date("2026-12-04T00:00:00Z"),
    nights: 3,
    guests: 2,
    pricingSnapshot: { totalMinor: 800000, currency: "INR" },
    listingSnapshot: { title: "Sea <b>house</b>", timezone: "Asia/Kolkata" },
    ...extra,
  };
}

function stubInbox({ pending = [], confirmed = [], completed = [] } = {}) {
  const finds = [];
  jest.spyOn(Reservation, "find").mockImplementation((filter) => {
    finds.push(filter);
    const rows = filter.status === "pending" ? pending : confirmed;
    const q = {
      sort: () => q,
      limit: () => q,
      populate: () => q,
      lean: async () => rows,
    };
    return q;
  });
  jest.spyOn(Reservation, "aggregate").mockResolvedValue(completed);
  return finds;
}

describe("GET /host/reservations", () => {
  test("signed out: redirect to log in", async () => {
    const res = await request(app(undefined)).get("/host/reservations");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test("pending first with a countdown, accept and decline forms with the CSRF token, guest summary", async () => {
    const pending = row();
    const finds = stubInbox({
      pending: [pending],
      confirmed: [row({ status: "confirmed", holdExpiresAt: undefined })],
      completed: [{ _id: guestDoc._id, count: 2 }],
    });
    const res = await request(app(host)).get("/host/reservations");
    expect(res.status).toBe(200);
    expect(String(finds[0].host)).toBe(String(host._id));
    expect(res.text.indexOf("Waiting for your answer")).toBeLessThan(
      res.text.indexOf("Confirmed stays"),
    );
    expect(res.text).toMatch(
      /<time data-expires="[^"]+" datetime="[^"]+">[45] h \d+ min<\/time>/,
    );
    expect(res.text).toContain(
      `action="/host/reservations/${pending._id}/accept"`,
    );
    expect(res.text).toContain(
      `action="/host/reservations/${pending._id}/decline"`,
    );
    expect(
      res.text.match(/name="_csrf" value="tok"/g).length,
    ).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain('name="reason"');
    expect(res.text).toContain('maxlength="500"');
    expect(res.text).toContain("member since Mar 2025");
    expect(res.text).toContain("2 earlier stays with you");
    expect(res.text).toContain("1 Dec 2026 – 4 Dec 2026");
    expect(res.text).toContain('<script src="/js/host-inbox.js"></script>');
  });

  test("a guest with no earlier stays", async () => {
    stubInbox({ pending: [row()] });
    const res = await request(app(host)).get("/host/reservations");
    expect(res.text).toContain("no earlier stays with you");
  });

  test("everything from a guest or a snapshot is escaped", async () => {
    stubInbox({ pending: [row()] });
    const res = await request(app(host)).get("/host/reservations");
    expect(res.text).not.toContain("<b>house</b>");
    expect(res.text).not.toContain("<i>R</i>");
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).toContain("Ravi &lt;i&gt;R&lt;/i&gt;");
  });

  test("a request whose hold ran out has no buttons and says so", async () => {
    const lapsed = row({ holdExpiresAt: new Date(NOW - 3600000) });
    stubInbox({ pending: [lapsed] });
    const res = await request(app(host)).get("/host/reservations");
    expect(res.text).toContain("has expired and can no longer be answered");
    expect(res.text).not.toContain("/accept");
    expect(res.text).not.toContain("/decline");
  });

  test("a host with nothing to do sees two calm empty states", async () => {
    stubInbox();
    const res = await request(app(stranger)).get("/host/reservations");
    expect(res.status).toBe(200);
    expect(res.text).toContain("No requests waiting");
    expect(res.text).toContain("No confirmed stays coming up");
  });

  test("the account menu offers the page", async () => {
    stubInbox();
    expect((await request(app(host)).get("/host/reservations")).text).toContain(
      'href="/host/reservations"',
    );
  });
});

describe("POST /host/reservations/:id/accept and /decline", () => {
  const id = new ObjectId();
  const stubReservation = (doc) =>
    jest.spyOn(Reservation, "findById").mockImplementation(async () => doc);
  const stubListing = (doc) =>
    jest
      .spyOn(Listing, "findById")
      .mockImplementation(() => ({ select: async () => doc }));

  test("accept: the service moves it, the host is sent back with a message", async () => {
    stubReservation({ _id: id, host: host._id, listing: new ObjectId() });
    stubListing({ status: "published", deletedAt: null });
    const move = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({});
    const flashes = [];
    const res = await request(app(host, flashes))
      .post(`/host/reservations/${id}/accept`)
      .type("form")
      .send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/host/reservations");
    expect(move).toHaveBeenCalledWith(
      id,
      "confirmed",
      expect.objectContaining({ actor: "host", by: host._id }),
    );
    expect(flashes[0][0]).toBe("success");
  });

  test("decline: the reason travels to the service", async () => {
    stubReservation({ _id: id, host: host._id, listing: new ObjectId() });
    const move = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({});
    const res = await request(app(host))
      .post(`/host/reservations/${id}/decline`)
      .type("form")
      .send({ reason: " Repairs that week " });
    expect(res.status).toBe(302);
    expect(move).toHaveBeenCalledWith(
      id,
      "declined",
      expect.objectContaining({ actor: "host", reason: "Repairs that week" }),
    );
  });

  test("an expired request: 409 and the inbox is shown again with the reason", async () => {
    stubReservation({ _id: id, host: host._id, listing: new ObjectId() });
    stubListing({ status: "published", deletedAt: null });
    jest
      .spyOn(reservationsService, "transition")
      .mockRejectedValue(
        new ConflictError(
          "This request has expired and can no longer be accepted.",
          { code: "hold_expired" },
        ),
      );
    stubInbox();
    const res = await request(app(host))
      .post(`/host/reservations/${id}/accept`)
      .type("form")
      .send({});
    expect(res.status).toBe(409);
    expect(res.text).toContain(
      "This request has expired and can no longer be accepted.",
    );
    expect(res.text).toContain("Booking requests");
  });

  test("accept after the listing was suspended: 409 with its message, the booking is not moved", async () => {
    stubReservation({ _id: id, host: host._id, listing: new ObjectId() });
    stubListing({ status: "suspended", deletedAt: null });
    const move = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({});
    stubInbox();
    const res = await request(app(host))
      .post(`/host/reservations/${id}/accept`)
      .type("form")
      .send({});
    expect(res.status).toBe(409);
    expect(res.text).toContain("suspended");
    expect(move).not.toHaveBeenCalled();
  });

  test("a reason over 500 characters is a 400", async () => {
    stubReservation({ _id: id, host: host._id, listing: new ObjectId() });
    const move = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({});
    const res = await request(app(host))
      .post(`/host/reservations/${id}/decline`)
      .type("form")
      .send({ reason: "x".repeat(501) });
    expect(res.status).toBe(400);
    expect(move).not.toHaveBeenCalled();
  });

  test.each([
    ["another member", stranger],
    ["the guest", person({ _id: guestDoc._id })],
    ["an admin", person({ role: "admin" })],
  ])("%s gets a 404 and nothing moves", async (_n, user) => {
    stubReservation({ _id: id, host: host._id, listing: new ObjectId() });
    const move = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({});
    for (const action of ["accept", "decline"]) {
      const res = await request(app(user))
        .post(`/host/reservations/${id}/${action}`)
        .type("form")
        .send({});
      expect(res.status).toBe(404);
    }
    expect(move).not.toHaveBeenCalled();
  });

  test("a malformed id is a 404 without touching the database", async () => {
    const find = stubReservation(null);
    const res = await request(app(host))
      .post("/host/reservations/not-an-id/accept")
      .type("form")
      .send({});
    expect(res.status).toBe(404);
    expect(find).not.toHaveBeenCalled();
  });

  test("signed out: no data, a redirect to log in", async () => {
    const find = stubReservation(null);
    const res = await request(app(undefined))
      .post(`/host/reservations/${id}/accept`)
      .type("form")
      .send({});
    expect([301, 302, 303]).toContain(res.status);
    expect(find).not.toHaveBeenCalled();
  });
});

describe("mounted in the real app", () => {
  const { createAgent } = require("../helpers/agent");
  test("a signed-out visitor is sent to log in, GET and POST", async () => {
    const agent = createAgent();
    const get = await agent.get("/host/reservations");
    expect(get.headers.location).toMatch(/^\/login/);
    const post = await agent.post(
      `/host/reservations/${"a".repeat(24)}/accept`,
    );
    expect([301, 302, 303]).toContain(post.status);
    expect(post.headers.location).toMatch(/^\/login/);
  });
});

describe("the countdown script", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "public", "js", "host-inbox.js"),
    "utf8",
  );
  const context = { document: undefined };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const { countdown } = context.DimoraHostInboxCore;
  test.each([
    [-5, ""],
    [0, ""],
    [20000, "less than a minute"],
    [42 * 60000, "42 min"],
    [5 * 3600000 + 12 * 60000, "5 h 12 min"],
    [26 * 3600000, "1 day 2 h"],
  ])("%i ms -> %j", (ms, text) => {
    expect(countdown(ms)).toBe(text);
  });
});
