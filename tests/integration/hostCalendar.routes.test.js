// P13-T02: GET /host/calendar through the real router, controller and EJS
// (layout included), models stubbed (no database).
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Listing = require("../../src/models/listing");
const StayNight = require("../../src/models/stayNight");
const Reservation = require("../../src/models/reservation");
const hostRouter = require("../../src/routes/host");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");
const { parseDateOnly } = require("../../src/utils/dates");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const host = {
  _id: new ObjectId(),
  username: "asha",
  role: "member",
  status: "active",
};

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
  a.use((req, res, next) => {
    req.user = user;
    req.isAuthenticated = () => Boolean(user);
    req.session = {};
    req.flash = () => [];
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
  a.use("/host", hostRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}

const chain = (rows) => {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    populate: () => q,
    lean: async () => rows,
  };
  return q;
};

function stub({ listings = [], nights = [], reservations = [] } = {}) {
  const l = jest
    .spyOn(Listing, "find")
    .mockImplementation(() => chain(listings));
  jest.spyOn(StayNight, "find").mockImplementation(() => chain(nights));
  jest.spyOn(Reservation, "find").mockImplementation(() => chain(reservations));
  return l;
}

describe("GET /host/calendar", () => {
  test("signed out: a redirect to log in", async () => {
    const res = await request(app(undefined)).get("/host/calendar");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test("a month of listings: row headers, day columns, states in words, links", async () => {
    const a = {
      _id: new ObjectId(),
      title: "Sea <b>house</b>",
      status: "published",
    };
    const b = {
      _id: new ObjectId(),
      title: "Hill cabin",
      status: "unpublished",
    };
    const r = {
      _id: new ObjectId(),
      host: host._id,
      status: "confirmed",
      guest: { _id: new ObjectId(), displayName: "Ravi" },
    };
    stub({
      listings: [a, b],
      nights: [
        {
          listing: a._id,
          date: parseDateOnly("2026-11-03"),
          source: { kind: "reservation", id: r._id },
        },
        {
          listing: b._id,
          date: parseDateOnly("2026-11-05"),
          source: { kind: "block", id: new ObjectId() },
        },
      ],
      reservations: [r],
    });
    const res = await request(app(host)).get("/host/calendar?month=2026-11");
    expect(res.status).toBe(200);
    expect(res.text).toContain("November 2026");
    expect(res.text).toContain('<th scope="row" class="ocal-listing">');
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).not.toContain("<b>house</b>");
    expect(res.text).toContain("not published");
    expect(res.text).toContain(`href="/trips/${r._id}"`);
    expect(res.text).toContain("Tuesday 3 November: booked, guest Ravi");
    expect(res.text).toContain(
      `href="/host/listings/${b._id}/calendar?month=2026-11"`,
    );
    expect(res.text).toContain("blocked by you");
    expect(res.text.match(/<th scope="col" class="ocal-day/g)).toHaveLength(30);
    expect(res.text).toContain('href="/host/calendar?month=2026-10"');
    expect(res.text).toContain('href="/host/calendar?month=2026-12"');
    expect(res.text).toContain("Legend");
  });

  test("no listings: a calm empty state, no table", async () => {
    stub();
    const res = await request(app(host)).get("/host/calendar");
    expect(res.status).toBe(200);
    expect(res.text).toContain("No listings to show");
    expect(res.text).not.toContain("ocal-listing");
  });

  test("it asks only for this host's listings", async () => {
    const find = stub();
    await request(app(host)).get("/host/calendar");
    expect(String(find.mock.calls[0][0].owner)).toBe(String(host._id));
  });

  test("the account menu links to it", async () => {
    stub();
    expect((await request(app(host)).get("/host/calendar")).text).toContain(
      'href="/host/calendar"',
    );
  });
});

describe("mounted in the real app", () => {
  const { createAgent } = require("../helpers/agent");
  test("a signed-out visitor is sent to log in", async () => {
    const res = await createAgent().get("/host/calendar");
    expect(res.headers.location).toMatch(/^\/login/);
  });
});
