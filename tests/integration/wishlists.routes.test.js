// P10-T01: /wishlists and POST /listings/:id/save through the real router,
// controller and EJS views (layout included), with the service stubbed (no
// database). Who is signed in is set by the test.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const service = require("../../src/services/wishlists");
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

const LISTING_ID = String(new ObjectId());

describe("POST /listings/:id/save", () => {
  test("signed out: redirected to log in, nothing saved", async () => {
    const spy = jest.spyOn(service, "setSaved");
    const res = await request(app(undefined))
      .post(`/listings/${LISTING_ID}/save`)
      .type("form")
      .send({ saved: "true" });
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
    expect(spy).not.toHaveBeenCalled();
  });

  test("fetch (Accept: json): saves for the signed-in member and answers JSON", async () => {
    const spy = jest
      .spyOn(service, "setSaved")
      .mockResolvedValue({ saved: true, changed: true });
    const res = await request(app(member))
      .post(`/listings/${LISTING_ID}/save`)
      .set("Accept", "application/json")
      .type("form")
      .send({ saved: "true" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: true, changed: true });
    expect(spy).toHaveBeenCalledWith(member._id, LISTING_ID, true);
  });

  test("a value other than true/false is a 400 and saves nothing", async () => {
    const spy = jest.spyOn(service, "setSaved");
    const res = await request(app(member))
      .post(`/listings/${LISTING_ID}/save`)
      .type("form")
      .send({ saved: "maybe" });
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  test("plain form: flash message and back to the page it came from", async () => {
    jest.spyOn(service, "setSaved").mockResolvedValue({ saved: true, changed: true });
    const flashes = [];
    const res = await request(app(member, flashes))
      .post(`/listings/${LISTING_ID}/save`)
      .set("Host", "dimora.test")
      .set("Referer", "http://dimora.test/listings?search=goa&page=2")
      .type("form")
      .send({ saved: "true" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/listings?search=goa&page=2");
    expect(flashes[0][0]).toBe("success");
  });

  test("a Referer on another site is ignored (no open redirect)", async () => {
    jest.spyOn(service, "setSaved").mockResolvedValue({ saved: false, changed: true });
    const res = await request(app(member))
      .post(`/listings/${LISTING_ID}/save`)
      .set("Host", "dimora.test")
      .set("Referer", "http://evil.test/phish")
      .type("form")
      .send({ saved: "false" });
    expect(res.headers.location).toBe(`/listings/${LISTING_ID}`);
  });
});

describe("GET /wishlists", () => {
  test("signed out: redirect to log in", async () => {
    const res = await request(app(undefined)).get("/wishlists");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test("empty list: friendly message", async () => {
    jest
      .spyOn(service, "overview")
      .mockResolvedValue({ items: [], availableCount: 0, limit: 100 });
    const res = await request(app(member)).get("/wishlists");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Nothing saved yet");
  });

  test("shows saved stays with a filled heart, and unavailable ones with a note and Remove", async () => {
    const a = String(new ObjectId());
    const b = String(new ObjectId());
    jest.spyOn(service, "overview").mockResolvedValue({
      availableCount: 1,
      limit: 100,
      items: [
        {
          id: a,
          available: true,
          title: "Sea house",
          card: { id: a, title: "Sea house", imageUrl: null, location: "Goa", country: "India", priceMinor: 500000, currency: "INR" },
        },
        { id: b, available: false, title: "Old <script>x</script> stay", card: null },
      ],
    });
    const res = await request(app(member)).get("/wishlists");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Sea house");
    expect(res.text).toContain('aria-pressed="true"'); // saved: the next click removes
    expect(res.text).toContain("No longer available");
    expect(res.text).toContain("Remove from saved");
    // the unavailable title is escaped, never executed
    expect(res.text).not.toContain("<script>x</script>");
    expect(res.text).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });
});
