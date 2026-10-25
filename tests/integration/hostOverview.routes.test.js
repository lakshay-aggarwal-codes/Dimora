// P13-T01: GET /host through the real router, controller and EJS (layout
// included), the service stubbed (no database).
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const overviewService = require("../../src/services/hostOverview");
const hostRouter = require("../../src/routes/host");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");

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
    res.status(err.statusCode || 500).send(String(err.message)),
  );
  return a;
}

const data = (extra = {}) => ({
  listingCount: 2,
  pending: {
    count: 3,
    soonestExpiry: new Date("2026-10-21T06:00:00Z"),
    capped: false,
  },
  week: {
    days: 7,
    checkIns: 2,
    checkOuts: 1,
    upcomingCheckIns: [
      {
        id: "64b0f0f0f0f0f0f0f0f0aaaa",
        title: "Sea <b>house</b>",
        guest: "Ravi",
        guests: 2,
        date: new Date("2026-10-22T00:00:00Z"),
      },
    ],
    upcomingCheckOuts: [
      {
        id: "64b0f0f0f0f0f0f0f0f0bbbb",
        title: "Hill cabin",
        guest: "Meera",
        guests: 1,
        date: new Date("2026-10-24T00:00:00Z"),
      },
    ],
    capped: false,
  },
  earnings: {
    estimateMinor: 1300000,
    stays: 2,
    monthStart: new Date("2026-10-01T00:00:00Z"),
    capped: false,
  },
  occupancy: {
    days: 30,
    percent: 16,
    bookedNights: 8,
    blockedNights: 10,
    availableNights: 50,
    listings: 2,
  },
  ...extra,
});

describe("GET /host", () => {
  test("signed out: a redirect to log in", async () => {
    const res = await request(app(undefined)).get("/host");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test("four tiles, each with its numbers and a link to its list", async () => {
    const run = jest
      .spyOn(overviewService, "overview")
      .mockResolvedValue(data());
    const res = await request(app(host)).get("/host");
    expect(res.status).toBe(200);
    expect(run.mock.calls[0][1]).toBe(host._id);
    for (const tile of ["pending", "week", "earnings", "occupancy"])
      expect(res.text).toContain(`data-tile="${tile}"`);
    expect(res.text).toMatch(/overview-number">3</);
    expect(res.text).toContain("The soonest runs out");
    expect(res.text).toContain("2 check-ins");
    expect(res.text).toContain("1 check-out");
    expect(res.text).toContain('href="/trips/64b0f0f0f0f0f0f0f0f0aaaa"');
    expect(res.text).toContain("22 Oct 2026");
    expect(res.text).toMatch(/₹13,000/);
    expect(res.text).toContain("Estimate, no payouts.");
    expect(res.text).toContain("without the guest service fee and taxes");
    expect(res.text).toMatch(/overview-number">16%</);
    expect(res.text).toContain("8 nights booked of 50 available");
    expect(res.text).toContain('href="/host/reservations"');
    expect(res.text).toContain('href="/host/reservations#inbox-confirmed"');
    expect(
      res.text.match(/href="\/host\/calendar"/g).length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("titles and guest names are escaped", async () => {
    jest.spyOn(overviewService, "overview").mockResolvedValue(data());
    const res = await request(app(host)).get("/host");
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).not.toContain("<b>house</b>");
  });

  test("calm text when there is nothing: no requests, nothing scheduled, no percentage", async () => {
    jest.spyOn(overviewService, "overview").mockResolvedValue(
      data({
        pending: { count: 0, soonestExpiry: null, capped: false },
        week: {
          days: 7,
          checkIns: 0,
          checkOuts: 0,
          upcomingCheckIns: [],
          upcomingCheckOuts: [],
          capped: false,
        },
        earnings: {
          estimateMinor: 0,
          stays: 0,
          monthStart: new Date("2026-10-01T00:00:00Z"),
          capped: false,
        },
        occupancy: {
          days: 30,
          percent: null,
          bookedNights: 0,
          blockedNights: 0,
          availableNights: 0,
          listings: 0,
        },
      }),
    );
    const res = await request(app(host)).get("/host");
    expect(res.text).toContain("No requests are waiting.");
    expect(res.text).toContain("Nothing is scheduled.");
    expect(res.text).toContain("Publish a listing to see its occupancy.");
    expect(res.text).toMatch(/₹0/);
  });

  test("every night blocked is explained, not shown as 0%", async () => {
    jest
      .spyOn(overviewService, "overview")
      .mockResolvedValue(
        data({
          occupancy: {
            days: 30,
            percent: null,
            bookedNights: 0,
            blockedNights: 30,
            availableNights: 0,
            listings: 1,
          },
        }),
      );
    expect((await request(app(host)).get("/host")).text).toContain(
      "Every night is blocked",
    );
  });

  test("a host with no listings is invited to create one, with no tiles", async () => {
    jest
      .spyOn(overviewService, "overview")
      .mockResolvedValue(data({ listingCount: 0 }));
    const res = await request(app(host)).get("/host");
    expect(res.text).toContain("You have no listings yet");
    expect(res.text).toContain('href="/host/listings/new"');
    expect(res.text).not.toContain("data-tile=");
  });

  test("the account menu offers it", async () => {
    jest.spyOn(overviewService, "overview").mockResolvedValue(data());
    expect((await request(app(host)).get("/host")).text).toContain(
      'href="/host"',
    );
  });
});

describe("mounted in the real app", () => {
  const { createAgent } = require("../helpers/agent");
  test("a signed-out visitor is sent to log in", async () => {
    const res = await createAgent().get("/host");
    expect(res.headers.location).toMatch(/^\/login/);
  });
});
