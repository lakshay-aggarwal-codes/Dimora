// P09-T01: /trips and /trips/:id through the real router, controller, service
// and EJS views (layout included), in a small Express app with the model
// stubbed (no database). Who is signed in is set by the test.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Reservation = require("../../src/models/reservation");
const tripsRouter = require("../../src/routes/trips");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");
const { parseDateOnly } = require("../../src/utils/dates");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const d = (s) => parseDateOnly(s);
const person = (extra = {}) => ({
  _id: new ObjectId(),
  username: "someone",
  role: "member",
  status: "active",
  ...extra,
});
const guest = person({ username: "ravi", displayName: "Ravi" });
const host = person({
  username: "asha",
  displayName: "Asha",
  email: "asha@example.com",
});
const stranger = person({ username: "eve" });
const admin = person({ username: "boss", role: "admin" });

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
    res.locals.success = [];
    res.locals.error = [];
    res.locals.currUser = user;
    res.locals.currentPath = req.path;
    res.locals.formatMoney = formatMoney;
    res.locals.can = (action, resource) => can(action, user, resource);
    res.locals.mapPublicToken = "";
    res.locals.csrfToken = "t";
    res.locals.cspNonce = "n";
    next();
  });
  a.use("/", tripsRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}

function bookingDoc(extra = {}) {
  return {
    _id: new ObjectId(),
    guest: { _id: guest._id, displayName: "Ravi", username: "ravi" },
    host: {
      _id: host._id,
      displayName: "Asha",
      username: "asha",
      email: "asha@example.com",
    },
    listing: {
      _id: new ObjectId(),
      title: "Live <b>title</b>",
      address: { line1: "12 Beach Road", city: "Goa", country: "India" },
      geometry: { type: "Point", coordinates: [73.8, 15.5] },
    },
    checkIn: d("2026-11-02"),
    checkOut: d("2026-11-05"),
    nights: 3,
    guests: 2,
    status: "confirmed",
    pricingSnapshot: {
      lines: [
        { code: "nights", unitMinor: 250000, quantity: 3, amountMinor: 750000 },
        { code: "cleaning", amountMinor: 50000 },
      ],
      totalMinor: 800000,
      avgPerNightMinor: 266667,
      currency: "INR",
    },
    listingSnapshot: {
      title: "Sea <script>alert(1)</script> house",
      city: "Goa",
      houseRules: "No parties <img src=x>",
      cancellationPolicy: "flexible",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      timezone: "Asia/Kolkata",
      instantBook: true,
    },
    ...extra,
  };
}

const chain = (value) => {
  const c = {
    populate: () => c,
    lean: () => c,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return c;
};
const stubFind = (doc) =>
  jest.spyOn(Reservation, "findById").mockImplementation(() => chain(doc));

describe("GET /trips/:id", () => {
  test("the guest sees the confirmation: stay, price lines, rules, policy, host contact, address", async () => {
    const doc = bookingDoc();
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain("Confirmed");
    expect(res.text).toMatch(/Booking <strong>DIM-[0-9A-F]{8}<\/strong>/);
    expect(res.text).toContain("2 Nov 2026");
    expect(res.text).toContain("from 14:00");
    expect(res.text).toMatch(/₹2,500\s×\s3 nights/);
    expect(res.text).toContain("Cleaning fee");
    expect(res.text).toMatch(/₹8,000/);
    expect(res.text).toContain("Cancellation terms: Flexible");
    expect(res.text).toContain(
      "Free cancellation until 24 hours before check-in",
    );
    expect(res.text).toContain("12 Beach Road");
    expect(res.text).toContain("mailto:asha@example.com");
    expect(res.text).toContain(
      "https://www.openstreetmap.org/?mlat=15.5&amp;mlon=73.8",
    );
    expect(res.text).toContain("instantly");
    expect(res.text).toContain("payments are simulated");
    expect(res.text).toContain("data-print");
    expect(res.text).toContain('<script src="/js/trips.js"></script>');
  });

  test("everything from the snapshot is escaped", async () => {
    const doc = bookingDoc();
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).not.toContain("<img src=x>");
    expect(res.text).toContain(
      "Sea &lt;script&gt;alert(1)&lt;/script&gt; house",
    );
    expect(res.text).toContain("No parties &lt;img src=x&gt;");
  });

  test("a pending request: the deadline is shown, the address and the host's contact are not", async () => {
    const doc = bookingDoc({
      status: "pending",
      holdExpiresAt: new Date(Date.now() + 5 * 3600000),
    });
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Waiting for the host");
    expect(res.text).toContain("has not answered yet");
    expect(res.text).toContain(
      "The exact address is shared once the booking is confirmed.",
    );
    expect(res.text).not.toContain("12 Beach Road");
    expect(res.text).not.toContain("asha@example.com");
    expect(res.text).not.toContain("openstreetmap");
  });

  test.each(["declined", "expired", "cancelled_by_guest", "cancelled_by_host"])(
    "%s: no address, no contact",
    async (status) => {
      const doc = bookingDoc({ status });
      stubFind(doc);
      const res = await request(app(guest)).get(`/trips/${doc._id}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("12 Beach Road");
      expect(res.text).not.toContain("asha@example.com");
    },
  );

  test("the host may open it and sees the guest's name, not the host contact block", async () => {
    const doc = bookingDoc();
    stubFind(doc);
    const res = await request(app(host)).get(`/trips/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Guest: <strong>Ravi</strong>");
    expect(res.text).not.toContain("Your host");
    expect(res.text).not.toContain("mailto:");
  });

  test("an admin may open it", async () => {
    const doc = bookingDoc();
    stubFind(doc);
    expect((await request(app(admin)).get(`/trips/${doc._id}`)).status).toBe(
      200,
    );
  });

  test("a stranger gets the same 404 as for a booking that does not exist", async () => {
    const doc = bookingDoc();
    stubFind(doc);
    const denied = await request(app(stranger)).get(`/trips/${doc._id}`);
    stubFind(null);
    const missing = await request(app(stranger)).get(`/trips/${doc._id}`);
    expect(denied.status).toBe(404);
    expect(denied.text).toBe(missing.text);
    expect(denied.text).not.toContain("Beach");
  });

  test("a suspended guest cannot read their own booking", async () => {
    const doc = bookingDoc();
    stubFind(doc);
    const res = await request(app({ ...guest, status: "suspended" })).get(
      `/trips/${doc._id}`,
    );
    expect(res.status).toBe(404);
  });

  test.each([
    "not-an-id",
    "123",
    "64b0f0f0f0f0f0f0f0f0abcZ",
    "64b0f0f0f0f0f0f0f0f0abc",
  ])(
    "a malformed id %j is a 404 and never reaches the database",
    async (id) => {
      const spy = stubFind(bookingDoc());
      const res = await request(app(guest)).get(
        `/trips/${encodeURIComponent(id)}`,
      );
      expect(res.status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  test("a signed-out visitor is sent to log in (no data)", async () => {
    const spy = stubFind(bookingDoc());
    const res = await request(app(undefined)).get(`/trips/${new ObjectId()}`);
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a booking whose listing was removed still renders from its snapshot", async () => {
    const doc = bookingDoc({ listing: null });
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Sea &lt;script&gt;");
    expect(res.text).not.toContain("View the listing");
  });
});

describe("GET /trips", () => {
  function stubList({ counts = [0, 0, 0, 0], rows = [] } = {}) {
    let n = 0;
    jest
      .spyOn(Reservation, "countDocuments")
      .mockImplementation(async () => counts[n++ % 4]);
    const calls = [];
    jest.spyOn(Reservation, "find").mockImplementation((filter) => {
      const c = { filter };
      calls.push(c);
      const q = {
        sort: () => q,
        skip: () => q,
        limit: () => q,
        lean: async () => rows,
      };
      return q;
    });
    return calls;
  }

  test("signed-out: redirect to login", async () => {
    const res = await request(app(undefined)).get("/trips");
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test("four tabs with counts; the chosen one is current; only this guest's bookings are asked for", async () => {
    const calls = stubList({
      counts: [2, 1, 0, 3],
      rows: [bookingDoc({ _id: new ObjectId() })],
    });
    const res = await request(app(guest)).get("/trips?tab=pending");
    expect(res.status).toBe(200);
    for (const label of ["Upcoming", "Pending", "Past", "Cancelled"])
      expect(res.text).toContain(label);
    expect(res.text).toMatch(
      /href="\/trips\?tab=pending"[^>]*aria-current="page"/,
    );
    expect(res.text).toMatch(
      /Pending <span class="badge text-bg-light trip-count">1<\/span>/,
    );
    expect(calls).toHaveLength(1);
    expect(String(calls[0].filter.guest)).toBe(String(guest._id));
  });

  test("a row links to its booking page", async () => {
    const doc = bookingDoc();
    stubList({ counts: [1, 0, 0, 0], rows: [doc] });
    const res = await request(app(guest)).get("/trips");
    expect(res.text).toContain(`href="/trips/${doc._id}"`);
    expect(res.text).toContain(
      "Sea &lt;script&gt;alert(1)&lt;/script&gt; house",
    );
    expect(res.text).not.toContain("<script>alert(1)");
  });

  test.each([
    ["upcoming", "No upcoming trips"],
    ["pending", "Nothing waiting for a host"],
    ["past", "No past trips yet"],
    ["cancelled", "Nothing cancelled"],
  ])("empty %s tab says so and offers a way on", async (tab, message) => {
    stubList();
    const res = await request(app(guest)).get(`/trips?tab=${tab}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(message);
    expect(res.text).toContain('href="/listings"');
  });

  test("an unknown tab shows upcoming, not an error", async () => {
    stubList();
    const res = await request(app(guest)).get("/trips?tab=everything");
    expect(res.status).toBe(200);
    expect(res.text).toContain("No upcoming trips");
  });

  test("the navbar offers the page to a signed-in member", async () => {
    stubList();
    const res = await request(app(guest)).get("/trips");
    expect(res.text).toContain('href="/trips"');
    expect(res.text).toContain("Your trips");
  });
});

describe("mounted in the real app", () => {
  const { createAgent } = require("../helpers/agent");
  test.each(["/trips", `/trips/${"a".repeat(24)}`])(
    "%s sends a signed-out visitor to log in",
    async (url) => {
      const res = await createAgent().get(url);
      expect([301, 302, 303]).toContain(res.status);
      expect(res.headers.location).toMatch(/^\/login/);
    },
  );
});
