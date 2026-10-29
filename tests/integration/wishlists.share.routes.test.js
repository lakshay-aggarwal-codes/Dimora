// P10-T04: share links for wishlists through the real router, controller and
// EJS views (layout included), with the services stubbed (no database). The
// rules are tested in tests/unit/sharedLists.service.test.js. Who is signed in
// is set by the test.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const service = require("../../src/services/wishlists");
const lists = require("../../src/services/wishlistLists");
const sharedLists = require("../../src/services/sharedLists");
const { ConflictError, NotFoundError, ValidationError } = require("../../src/utils/errors");
const wishlistsRouter = require("../../src/routes/wishlists");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const member = {
  _id: new ObjectId(),
  username: "asha",
  role: "member",
  status: "active",
};

function app(user, flashes = []) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  a.locals.appBaseUrl = "https://dimora.example.com/";
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
  a.use("/", wishlistsRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}

const LIST_A = String(new ObjectId());
const TOKEN = "T".repeat(32);
const card = (id, title) => ({ id, title, imageUrl: null, location: "Goa", country: "India", priceMinor: 500000, currency: "INR" });

function stubOwnerPage(shareToken) {
  jest.spyOn(service, "listsFor").mockResolvedValue([{ id: LIST_A, name: "Goa trip", isDefault: false, count: 1, shareToken }]);
  jest.spyOn(service, "overview").mockResolvedValue({ items: [], availableCount: 0, limit: 100 });
}

describe("the owner's list page", () => {
  test("not shared: a button to create a link", async () => {
    stubOwnerPage(null);
    const res = await request(app(member)).get(`/wishlists?list=${LIST_A}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-share");
    expect(res.text).toContain(`action="/wishlists/${LIST_A}/share"`);
    expect(res.text).toContain("Create a share link");
    expect(res.text).not.toContain("data-share-url");
  });

  test("shared: the full link and a stop button", async () => {
    stubOwnerPage(TOKEN);
    const res = await request(app(member)).get(`/wishlists?list=${LIST_A}`);
    expect(res.text).toContain(`value="https://dimora.example.com/shared/lists/${TOKEN}"`);
    expect(res.text).toContain(`action="/wishlists/${LIST_A}/share/revoke"`);
    expect(res.text).not.toContain("Create a share link");
  });

  test("the page of every saved stay has no share box", async () => {
    stubOwnerPage(TOKEN);
    const res = await request(app(member)).get("/wishlists");
    expect(res.text).not.toContain("data-share>");
    expect(res.text).not.toContain(TOKEN);
  });
});

describe("POST share and revoke", () => {
  test("only the signed-in member's own list (the service decides); back to the list with a message", async () => {
    const spy = jest.spyOn(sharedLists, "enableShare").mockResolvedValue({ token: TOKEN, created: true });
    const flashes = [];
    const res = await request(app(member, flashes)).post(`/wishlists/${LIST_A}/share`).type("form").send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/wishlists?list=${LIST_A}`);
    expect(spy.mock.calls[0].slice(0, 2)).toEqual([member._id, LIST_A]);
    expect(flashes[0][0]).toBe("success");
    expect(JSON.stringify(flashes)).not.toContain(TOKEN); // the link is shown on the page, not in a flash

    const revoke = jest.spyOn(sharedLists, "revokeShare").mockResolvedValue({ revoked: true });
    const r2 = await request(app(member)).post(`/wishlists/${LIST_A}/share/revoke`).type("form").send({});
    expect(r2.headers.location).toBe(`/wishlists?list=${LIST_A}`);
    expect(revoke.mock.calls[0].slice(0, 2)).toEqual([member._id, LIST_A]);
  });

  test("someone else's list is a 404; signed out goes to login and calls nothing", async () => {
    jest.spyOn(sharedLists, "enableShare").mockRejectedValue(new NotFoundError("That list does not exist."));
    expect((await request(app(member)).post(`/wishlists/${LIST_A}/share`).type("form").send({})).status).toBe(404);
    jest.restoreAllMocks();
    const spy = jest.spyOn(sharedLists, "enableShare");
    for (const url of [`/wishlists/${LIST_A}/share`, `/wishlists/${LIST_A}/share/revoke`]) {
      const res = await request(app(undefined)).post(url).type("form").send({});
      expect([301, 302, 303]).toContain(res.status);
      expect(res.headers.location).toMatch(/\/login/);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("GET /shared/lists/:token (public)", () => {
  const data = { name: "Goa <i>trip</i>", ownerName: "Ravi <b>R</b>", items: [card("a1", "Sea house"), card("b2", "Hill cabin")], hidden: 1 };

  test("anyone with the link sees the name, the owner's display name and the cards, read-only", async () => {
    const spy = jest.spyOn(sharedLists, "viewShared").mockResolvedValue(data);
    const res = await request(app(undefined)).get(`/shared/lists/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][0]).toBe(TOKEN);
    expect(res.text).toContain("Goa &lt;i&gt;trip&lt;/i&gt;");
    expect(res.text).toContain("Ravi &lt;b&gt;R&lt;/b&gt;");
    expect(res.text).not.toContain("<i>trip</i>");
    expect(res.text).toContain("data-shared-items");
    expect(res.text).toContain("Sea house");
    expect(res.text).toContain("1 stay is no longer available");
    // nothing to manage here
    for (const owned of ["data-share>", "/share/revoke", "data-item-tools", "data-list-tools", "Remove from saved", "compare-form"]) {
      expect(res.text).not.toContain(owned);
    }
  });

  test("the link is the credential: not indexed, not cached, not leaked in the Referer header", async () => {
    jest.spyOn(sharedLists, "viewShared").mockResolvedValue(data);
    const res = await request(app(undefined)).get(`/shared/lists/${TOKEN}`);
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  test("an empty list says so", async () => {
    jest.spyOn(sharedLists, "viewShared").mockResolvedValue({ ...data, items: [], hidden: 0 });
    const res = await request(app(undefined)).get(`/shared/lists/${TOKEN}`);
    expect(res.text).toContain("No stays to show");
    expect(res.text).not.toContain("data-shared-hidden");
  });

  test("a wrong, revoked or malformed link is a 404 that says nothing about why", async () => {
    jest.spyOn(sharedLists, "viewShared").mockRejectedValue(new NotFoundError("That shared list does not exist."));
    for (const token of [TOKEN, "short", "x".repeat(200)]) {
      const res = await request(app(undefined)).get(`/shared/lists/${token}`);
      expect(res.status).toBe(404);
    }
  });
});
