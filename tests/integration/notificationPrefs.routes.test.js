// P11-T05: /account/notifications and the unsubscribe pages through the real
// router, controller and EJS views (layout included), with the saving stubbed
// (no database). The rules are tested in tests/unit/notificationEmail.test.js.
// Who is signed in is set by the test.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const prefs = require("../../src/services/notificationEmail");
const notificationPrefsRouter = require("../../src/routes/notificationPrefs");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");

afterEach(() => jest.restoreAllMocks());

const SECRET = "s".repeat(40);
const ROOT = path.join(__dirname, "..", "..");
const member = {
  _id: new ObjectId(),
  username: "asha",
  role: "member",
  status: "active",
  emailVerifiedAt: new Date("2026-01-01"),
  notificationEmail: { reviews: false },
};

function app(user, flashes = []) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  a.locals.notificationSecret = SECRET;
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
  a.use("/", notificationPrefsRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}

const token = (group = "bookings", userId = String(member._id)) => prefs.unsubscribeToken({ userId, group, secret: SECRET });

describe("GET /account/notifications", () => {
  test("every group with its switch; the optional ones follow the member's choice; the essential one is locked on", async () => {
    const res = await request(app(member)).get("/account/notifications");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.text).toContain("data-notification-prefs");
    expect(res.text).toContain('name="_csrf" value="tok"');
    expect(res.text).toMatch(/id="pref-bookings"[^>]*checked/);
    expect(res.text).toMatch(/id="pref-reminders"[^>]*checked/);
    expect(res.text).not.toMatch(/id="pref-reviews"[^>]*checked/);
    expect(res.text).toMatch(/id="pref-moderation"[^>]*checked[^>]*disabled|id="pref-moderation"[^>]*disabled[^>]*checked/);
    expect(res.text).toContain("(always on)");
    expect(res.text).not.toContain("data-email-unconfirmed");
  });

  test("an unconfirmed address is explained", async () => {
    const res = await request(app({ ...member, emailVerifiedAt: null })).get("/account/notifications");
    expect(res.text).toContain("data-email-unconfirmed");
  });

  test("signed out goes to login", async () => {
    const res = await request(app(undefined)).get("/account/notifications");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });
});

describe("POST /account/notifications", () => {
  test("saves for the signed-in member only, from the form's switches", async () => {
    const spy = jest.spyOn(prefs, "savePrefs").mockResolvedValue({});
    const flashes = [];
    const res = await request(app(member, flashes)).post("/account/notifications").type("form").send({ bookings: "on", userId: "x" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/account/notifications");
    expect(spy.mock.calls[0][0]).toBe(member._id);
    expect(spy.mock.calls[0][1].bookings).toBe("on");
    expect(flashes[0][0]).toBe("success");
  });

  test("signed out: nothing is saved", async () => {
    const spy = jest.spyOn(prefs, "savePrefs");
    const res = await request(app(undefined)).post("/account/notifications").type("form").send({ bookings: "on" });
    expect([301, 302, 303]).toContain(res.status);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("unsubscribe links", () => {
  test("opening the link shows a button and changes NOTHING", async () => {
    const spy = jest.spyOn(prefs, "unsubscribe");
    const res = await request(app(undefined)).get(`/email/unsubscribe/${token()}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Stop <strong>Bookings</strong> emails");
    expect(res.text).toContain('action="/email/unsubscribe"');
    expect(res.text).toContain(`name="token" value="${token()}"`);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a made-up, tampered, essential-group or other-secret token is the same 400 page", async () => {
    const good = token();
    for (const bad of ["nope", good.slice(0, -2) + "xx", token("moderation"), prefs.unsubscribeToken({ userId: String(member._id), group: "bookings", secret: "z".repeat(40) })]) {
      const res = await request(app(undefined)).get(`/email/unsubscribe/${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.text).toContain("This link does not work");
    }
  });

  test("the button switches the group off, signed in or not, and says so", async () => {
    const spy = jest.spyOn(prefs, "unsubscribe").mockResolvedValue({ ok: true, group: { label: "Bookings" } });
    const flashes = [];
    const res = await request(app(undefined, flashes)).post("/email/unsubscribe").type("form").send({ token: token() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    expect(spy.mock.calls[0][0]).toBe(token());
    expect(spy.mock.calls[0][1]).toBe(SECRET);
    expect(flashes[0][1]).toMatch(/no longer get "Bookings" emails/);
    const signedIn = await request(app(member)).post("/email/unsubscribe").type("form").send({ token: token() });
    expect(signedIn.headers.location).toBe("/account/notifications");
  });

  test("a bad token in the POST is a 400 and sends no mail changes", async () => {
    jest.spyOn(prefs, "unsubscribe").mockResolvedValue({ ok: false });
    const res = await request(app(undefined)).post("/email/unsubscribe").type("form").send({ token: "junk" });
    expect(res.status).toBe(400);
  });
});
