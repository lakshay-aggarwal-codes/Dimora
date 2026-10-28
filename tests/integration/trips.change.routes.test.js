// P09-T04: the change-dates pages and routes through the real router,
// controller and EJS views (layout included), in a small Express app with the
// models and the modification service stubbed (no database). Who is signed in
// is set by the test. The service itself is tested in
// tests/unit/modifications.service.test.js.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Reservation = require("../../src/models/reservation");
const User = require("../../src/models/user");
const modifications = require("../../src/services/modifications");
const tripsRouter = require("../../src/routes/trips");
const hostRouter = require("../../src/routes/host");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");
const { parseDateOnly } = require("../../src/utils/dates");
const { ConflictError, ValidationError, NotFoundError, PriceChangedError } = require("../../src/utils/errors");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const person = (extra = {}) => ({
  _id: new ObjectId(),
  username: "someone",
  role: "member",
  status: "active",
  ...extra,
});
const guest = person({ username: "ravi", displayName: "Ravi" });
const host = person({ username: "asha", displayName: "Asha" });
const stranger = person({ username: "eve" });
const admin = person({ username: "root", role: "admin" });

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
  a.use("/", tripsRouter);
  a.use("/host", hostRouter);
  a.get("/profile-preview", (req, res) =>
    res.render("users/profile.ejs", {
      profile: req.app.locals.profile,
      isOwn: false,
      pageTitle: "p",
    }),
  );
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res
      .status(err.statusCode || 500)
      .send(`${err.statusCode || 500}: ${err.message}`),
  );
  return a;
}

const FUTURE = {
  checkIn: parseDateOnly("2099-06-10"),
  checkOut: parseDateOnly("2099-06-13"),
};

function booking(extra = {}) {
  return {
    _id: new ObjectId(),
    guest: { _id: guest._id, displayName: "Ravi", username: "ravi" },
    host: { _id: host._id, displayName: "Asha", username: "asha", email: "asha@example.com" },
    listing: { _id: new ObjectId(), title: "Live title", address: { city: "Goa" } },
    ...FUTURE,
    nights: 3,
    guests: 2,
    status: "confirmed",
    createdAt: new Date("2099-01-01T00:00:00Z"),
    pricingSnapshot: {
      lines: [
        { code: "nights", unitMinor: 250000, quantity: 3, amountMinor: 750000 },
        { code: "cleaning", amountMinor: 50000 },
      ],
      totalMinor: 800000,
      currency: "INR",
    },
    listingSnapshot: {
      title: "Sea house",
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
  const c = { populate: () => c, lean: () => c, select: () => c, then: (res, rej) => Promise.resolve(value).then(res, rej) };
  return c;
};
const stubFind = (doc) => jest.spyOn(Reservation, "findById").mockImplementation(() => chain(doc));

// What previewChange returns for 1-3 July 2099 (two nights, cheaper than three).
function preview(doc, extra = {}) {
  return {
    reservation: doc,
    listing: { _id: new ObjectId(), title: "Live title" },
    reapproval: doc.status === "pending",
    requested: true,
    problems: [],
    checkIn: parseDateOnly("2099-07-01"),
    checkOut: parseDateOnly("2099-07-03"),
    quote: {
      nights: 2,
      lines: [
        { code: "nights", unitMinor: 250000, quantity: 2, amountMinor: 500000 },
        { code: "cleaning", amountMinor: 50000 },
      ],
      totalMinor: 550000,
      currency: "INR",
    },
    differenceMinor: -250000,
    ...extra,
  };
}

describe("GET /trips/:id: the change section and the history", () => {
  test("the guest of a confirmed future booking is offered the change", async () => {
    const doc = booking();
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-change-section");
    expect(res.text).toContain(`href="/trips/${doc._id}/change"`);
    expect(res.text).not.toContain("data-changes");
  });

  test("a pending request says the host decides again", async () => {
    const doc = booking({ status: "pending", holdExpiresAt: new Date("2099-01-02T00:00:00Z") });
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.text).toContain("data-change-section");
    expect(res.text).toContain("the host decides again on the new dates");
  });

  test("not for the host, an admin, a closed booking or a started stay", async () => {
    const doc = booking();
    stubFind(doc);
    expect((await request(app(host)).get(`/trips/${doc._id}`)).text).not.toContain("data-change-section");
    expect((await request(app(admin)).get(`/trips/${doc._id}`)).text).not.toContain("data-change-section");
    const closed = booking({ status: "cancelled_by_guest" });
    stubFind(closed);
    expect((await request(app(guest)).get(`/trips/${closed._id}`)).text).not.toContain("data-change-section");
    const started = booking({ checkIn: parseDateOnly("2020-06-10"), checkOut: parseDateOnly("2020-06-13") });
    stubFind(started);
    expect((await request(app(guest)).get(`/trips/${started._id}`)).text).not.toContain("data-change-section");
  });

  test("the history of changes is shown to the guest and the host", async () => {
    const doc = booking({
      modifications: [
        {
          at: new Date("2099-01-05T06:00:00Z"),
          from: { checkIn: parseDateOnly("2099-06-08"), checkOut: parseDateOnly("2099-06-11") },
          to: { checkIn: parseDateOnly("2099-06-10"), checkOut: parseDateOnly("2099-06-13") },
          differenceMinor: 100000,
          currency: "INR",
          reapproval: false,
        },
      ],
    });
    stubFind(doc);
    for (const viewer of [guest, host]) {
      const res = await request(app(viewer)).get(`/trips/${doc._id}`);
      expect(res.text).toContain("data-changes");
      expect(res.text).toContain("dates moved from 8 Jun 2099 to 11 Jun 2099 to 10 Jun 2099 to 13 Jun 2099");
      expect(res.text).toContain("₹1,000 more");
    }
  });
});

describe("GET /trips/:id/change", () => {
  test("without dates: the form with today as the earliest day and no price", async () => {
    const doc = booking();
    const spy = jest.spyOn(modifications, "previewChange").mockResolvedValue({
      reservation: doc, listing: {}, reapproval: false, requested: false, problems: [], quote: null, differenceMinor: null,
    });
    const res = await request(app(guest)).get(`/trips/${doc._id}/change`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.text).toContain("data-change-form");
    expect(res.text).toContain("data-current-stay");
    expect(res.text).toMatch(/name="in"[^>]*required/);
    expect(res.text).toMatch(/min="\d{4}-\d{2}-\d{2}"/);
    expect(res.text).toContain("data-no-proposal");
    expect(res.text).not.toContain("data-new-stay");
    expect(res.text).not.toContain("data-change-confirm");
    expect(spy.mock.calls[0][0]).toEqual(expect.objectContaining({ id: String(doc._id), user: guest, in: undefined, out: undefined }));
  });

  test("with dates: the new lines, the new total, the difference and a confirm form with the CSRF token and the total", async () => {
    const doc = booking();
    jest.spyOn(modifications, "previewChange").mockResolvedValue(preview(doc));
    const res = await request(app(guest)).get(`/trips/${doc._id}/change?in=2099-07-01&out=2099-07-03`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-new-stay");
    expect(res.text).toContain("₹5,500");
    expect(res.text).toContain('data-difference="less"');
    expect(res.text).toContain("The new stay costs ₹2,500 less.");
    expect(res.text).toContain("data-immediate");
    expect(res.text).toContain(`action="/trips/${doc._id}/change" method="POST"`);
    expect(res.text).toContain('name="_csrf" value="tok"');
    expect(res.text).toContain('name="expectedTotalMinor" value="550000"');
    expect(res.text).toContain('name="in" value="2099-07-01"');
    expect(res.text).toContain("Confirm the new dates");
    expect(res.text).toContain("no money is taken or returned");
  });

  test("a pending request: the button and the text say the host answers again", async () => {
    const doc = booking({ status: "pending", holdExpiresAt: new Date("2099-01-02T00:00:00Z") });
    jest.spyOn(modifications, "previewChange").mockResolvedValue(preview(doc));
    const res = await request(app(guest)).get(`/trips/${doc._id}/change?in=2099-07-01&out=2099-07-03`);
    expect(res.text).toContain("data-reapproval");
    expect(res.text).toContain("Send the new dates to the host");
    expect(res.text).not.toContain("data-immediate");
  });

  test("problems are listed and no price or confirm form is offered", async () => {
    const doc = booking();
    jest.spyOn(modifications, "previewChange").mockResolvedValue(
      preview(doc, { problems: [{ code: "nights_unavailable", message: "These nights are not available: 2099-07-02." }], quote: null, differenceMinor: null }),
    );
    const res = await request(app(guest)).get(`/trips/${doc._id}/change?in=2099-07-01&out=2099-07-03`);
    expect(res.text).toContain("data-problems");
    expect(res.text).toContain("These nights are not available: 2099-07-02.");
    expect(res.text).not.toContain("data-change-confirm");
  });

  test("everything written into the page is escaped", async () => {
    const doc = booking({ listingSnapshot: { ...booking().listingSnapshot, title: "<script>alert(1)</script>" } });
    jest.spyOn(modifications, "previewChange").mockResolvedValue(preview(doc, { problems: [{ code: "x", message: "<img src=x onerror=alert(1)>" }], quote: null, differenceMinor: null }));
    const res = await request(app(guest)).get(`/trips/${doc._id}/change?in=2099-07-01&out=2099-07-03`);
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(res.text).not.toContain("<img src=x onerror=alert(1)>");
  });

  test("repeated or bracketed parameters never reach the service as anything but plain text", async () => {
    const doc = booking();
    const spy = jest.spyOn(modifications, "previewChange").mockResolvedValue({
      reservation: doc, listing: {}, reapproval: false, requested: false, problems: [], quote: null, differenceMinor: null,
    });
    await request(app(guest)).get(`/trips/${doc._id}/change?in=2099-07-01&in=2099-07-02&out[$gt]=1`);
    const call = spy.mock.calls[0][0];
    expect(call.in).toBeUndefined();
    expect(call.out).toBeUndefined();
  });

  test("a booking that cannot be changed goes back to the booking page with the reason", async () => {
    const flashes = [];
    jest.spyOn(modifications, "previewChange").mockRejectedValue(new ConflictError("This stay has already started, so its dates can no longer be changed.", { code: "stay_started" }));
    const res = await request(app(guest, flashes)).get("/trips/" + new ObjectId() + "/change");
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/trips\/[0-9a-f]{24}$/);
    expect(flashes[0]).toEqual(["error", "This stay has already started, so its dates can no longer be changed."]);
  });

  test("someone else's or a missing booking is the same 404", async () => {
    jest.spyOn(modifications, "previewChange").mockRejectedValue(new NotFoundError("That booking does not exist."));
    const res = await request(app(stranger)).get("/trips/" + new ObjectId() + "/change");
    expect(res.status).toBe(404);
  });
});

describe("POST /trips/:id/change", () => {
  const fields = { in: "2099-07-01", out: "2099-07-03", expectedTotalMinor: "550000" };

  test("success: the service gets the guest, the dates and the total; back to the booking with a message", async () => {
    const doc = booking();
    const spy = jest.spyOn(modifications, "changeDates").mockResolvedValue({ reservation: { _id: doc._id }, reapproval: false, differenceMinor: -250000 });
    const flashes = [];
    const res = await request(app(guest, flashes)).post(`/trips/${doc._id}/change`).type("form").send(fields);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/trips/${doc._id}`);
    expect(spy.mock.calls[0][0]).toEqual(expect.objectContaining({ id: String(doc._id), user: guest, in: "2099-07-01", out: "2099-07-03", expectedTotalMinor: "550000" }));
    expect(flashes[0][0]).toBe("success");
    expect(flashes[0][1]).toMatch(/Your dates are changed/);
  });

  test("a pending request: the message says it went back to the host", async () => {
    const doc = booking({ status: "pending" });
    jest.spyOn(modifications, "changeDates").mockResolvedValue({ reservation: { _id: doc._id }, reapproval: true, differenceMinor: 0 });
    const flashes = [];
    await request(app(guest, flashes)).post(`/trips/${doc._id}/change`).type("form").send(fields);
    expect(flashes[0][1]).toMatch(/sent back to the host/);
  });

  test("the form cannot choose the guest, the status or the price: only dates and the expected total are read", async () => {
    const doc = booking();
    const spy = jest.spyOn(modifications, "changeDates").mockResolvedValue({ reservation: { _id: doc._id }, reapproval: false });
    await request(app(guest)).post(`/trips/${doc._id}/change`).type("form").send({ ...fields, user: "x", guest: "y", status: "confirmed", pricingSnapshot: "z", guests: "9" });
    const arg = spy.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(["expectedTotalMinor", "id", "in", "out", "user"]);
    expect(arg.user).toBe(guest);
  });

  test("the price moved: nothing was changed, the page is shown again with the new price (409)", async () => {
    const doc = booking();
    jest.spyOn(modifications, "changeDates").mockRejectedValue(new PriceChangedError({ totalMinor: 600000 }));
    jest.spyOn(modifications, "previewChange").mockResolvedValue(preview(doc));
    const res = await request(app(guest)).post(`/trips/${doc._id}/change`).type("form").send(fields);
    expect(res.status).toBe(409);
    expect(res.text).toContain("data-price-changed");
    expect(res.text).toContain("data-change-confirm");
  });

  test("nights taken meanwhile: back to the change page with the dates kept", async () => {
    const doc = booking();
    jest.spyOn(modifications, "changeDates").mockRejectedValue(new ConflictError("Those nights are no longer available.", { code: "nights_unavailable" }));
    const flashes = [];
    const res = await request(app(guest, flashes)).post(`/trips/${doc._id}/change`).type("form").send(fields);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/trips/${doc._id}/change?in=2099-07-01&out=2099-07-03`);
    expect(flashes[0][0]).toBe("error");
  });

  test("a booking rule (its own code): back to the change page with its message", async () => {
    const doc = booking();
    jest.spyOn(modifications, "changeDates").mockRejectedValue(new ValidationError("Stays are at least 2 nights.", { code: "below_min_nights" }));
    const flashes = [];
    const res = await request(app(guest, flashes)).post(`/trips/${doc._id}/change`).type("form").send(fields);
    expect(res.headers.location).toBe(`/trips/${doc._id}/change?in=2099-07-01&out=2099-07-03`);
    expect(flashes[0]).toEqual(["error", "Stays are at least 2 nights."]);
  });

  test("the booking changed or closed meanwhile: back to the booking page", async () => {
    const doc = booking();
    jest.spyOn(modifications, "changeDates").mockRejectedValue(new ConflictError("That booking changed. Please reload and try again.", { code: "conflict" }));
    const flashes = [];
    const res = await request(app(guest, flashes)).post(`/trips/${doc._id}/change`).type("form").send(fields);
    expect(res.headers.location).toBe(`/trips/${doc._id}`);
    expect(flashes[0][0]).toBe("error");
  });

  test("someone else's booking is a 404", async () => {
    jest.spyOn(modifications, "changeDates").mockRejectedValue(new NotFoundError("That booking does not exist."));
    const res = await request(app(stranger)).post("/trips/" + new ObjectId() + "/change").type("form").send(fields);
    expect(res.status).toBe(404);
  });

  test("a malformed total is a plain 400 (not a rule message)", async () => {
    jest.spyOn(modifications, "changeDates").mockRejectedValue(new ValidationError("The expected total must be a whole number of paise."));
    const res = await request(app(guest)).post("/trips/" + new ObjectId() + "/change").type("form").send({ ...fields, expectedTotalMinor: "abc" });
    expect(res.status).toBe(400);
  });
});
