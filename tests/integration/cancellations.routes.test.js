// P09-T03: the cancel buttons and pages through the real routers, controllers,
// services and EJS views (layout included), in a small Express app with the
// models stubbed (no database). Who is signed in is set by the test.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Reservation = require("../../src/models/reservation");
const User = require("../../src/models/user");
const reservationsService = require("../../src/services/reservations");
const tripsRouter = require("../../src/routes/trips");
const hostRouter = require("../../src/routes/host");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");
const { parseDateOnly } = require("../../src/utils/dates");
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

// A stay far in the future (the page uses the real clock), one far in the past.
const FUTURE = {
  checkIn: parseDateOnly("2099-06-10"),
  checkOut: parseDateOnly("2099-06-13"),
};
const PAST = {
  checkIn: parseDateOnly("2020-06-10"),
  checkOut: parseDateOnly("2020-06-13"),
};

function booking(extra = {}) {
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
      title: "Live title",
      address: { city: "Goa" },
    },
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
      subtotalMinor: 750000,
      avgPerNightMinor: 250000,
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
  const c = {
    populate: () => c,
    lean: () => c,
    select: () => c,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return c;
};
const stubFind = (doc) =>
  jest.spyOn(Reservation, "findById").mockImplementation(() => chain(doc));
// the service reads the booking with the guest and host as plain ids
const plain = (doc) => ({ ...doc, guest: doc.guest._id, host: doc.host._id });

describe("GET /trips/:id: the cancel section", () => {
  test("the guest of a confirmed future booking sees what cancelling would refund and a form with the CSRF token", async () => {
    const doc = booking();
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-cancel-section");
    expect(res.text).toMatch(
      /If you cancel now you get everything back: <strong>₹8,000<\/strong>/,
    );
    expect(res.text).toMatch(/stays true until/);
    expect(res.text).toContain(`action="/trips/${doc._id}/cancel"`);
    expect(res.text).toContain('name="_csrf" value="tok"');
    expect(res.text).toContain('name="reason"');
    expect(res.text).toContain('maxlength="500"');
    expect(res.text).toContain("Cancelling cannot be undone");
    expect(res.text).toContain("does not move money");
  });

  test("a late cancellation says how much comes back and how much the host keeps", async () => {
    // check-in is years away; a strict policy on a booking made long ago refunds half
    const doc = booking({ createdAt: new Date("2020-01-01T00:00:00Z") });
    doc.listingSnapshot.cancellationPolicy = "strict";
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.text).toMatch(
      /you get <strong>₹4,000<\/strong> back of ₹8,000; the host keeps ₹4,000/,
    );
  });

  test("a pending request can be withdrawn for free", async () => {
    const doc = booking({
      status: "pending",
      holdExpiresAt: new Date("2099-01-02T00:00:00Z"),
    });
    doc.listingSnapshot.cancellationPolicy = "strict";
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.text).toContain("data-cancel-section");
    expect(res.text).toMatch(/everything back: <strong>₹8,000<\/strong>/);
    expect(res.text).toContain("cancelling is free");
  });

  test("no cancel section for the host or an admin viewing, for a finished stay, or for an already cancelled booking", async () => {
    const future = booking();
    stubFind(future);
    expect(
      (await request(app(host)).get(`/trips/${future._id}`)).text,
    ).not.toContain("data-cancel-section");
    expect(
      (await request(app(admin)).get(`/trips/${future._id}`)).text,
    ).not.toContain("data-cancel-section");

    const past = booking({ ...PAST });
    stubFind(past);
    expect(
      (await request(app(guest)).get(`/trips/${past._id}`)).text,
    ).not.toContain("data-cancel-section");

    for (const status of [
      "cancelled_by_guest",
      "cancelled_by_host",
      "declined",
      "expired",
      "completed",
    ]) {
      const done = booking({ status });
      stubFind(done);
      expect(
        (await request(app(guest)).get(`/trips/${done._id}`)).text,
      ).not.toContain("data-cancel-section");
    }
  });

  test("a cancelled booking shows who cancelled, the reason (escaped) and the recorded refund", async () => {
    const doc = booking({
      status: "cancelled_by_host",
      cancelReason: "Pipe <b>burst</b>",
      refund: {
        amountMinor: 800000,
        retainedMinor: 0,
        totalMinor: 800000,
        currency: "INR",
        rule: "host_cancelled",
        policy: "flexible",
      },
    });
    stubFind(doc);
    const res = await request(app(guest)).get(`/trips/${doc._id}`);
    expect(res.text).toContain("data-cancelled");
    expect(res.text).toContain("The host cancelled this booking");
    expect(res.text).toContain("Pipe &lt;b&gt;burst&lt;/b&gt;");
    expect(res.text).not.toContain("Pipe <b>burst</b>");
    expect(res.text).toMatch(/Refund: ₹8,000\./);
    expect(res.text).toContain(
      "The host cancelled, so you get everything back.",
    );
    expect(res.text).toContain("payments are simulated");
  });

  test("a guest cancellation with a partial refund says what the host keeps; with none it says nothing comes back", async () => {
    const partial = booking({
      status: "cancelled_by_guest",
      refund: {
        amountMinor: 300000,
        retainedMinor: 500000,
        totalMinor: 800000,
        currency: "INR",
        rule: "moderate_late",
      },
    });
    stubFind(partial);
    expect(
      (await request(app(guest)).get(`/trips/${partial._id}`)).text,
    ).toMatch(/Refund: ₹3,000 \(the host keeps ₹5,000\)\./);
    const none = booking({
      status: "cancelled_by_guest",
      refund: {
        amountMinor: 0,
        retainedMinor: 800000,
        totalMinor: 800000,
        currency: "INR",
        rule: "strict_none",
      },
    });
    stubFind(none);
    const text = (await request(app(guest)).get(`/trips/${none._id}`)).text;
    expect(text).toMatch(/Refund: ₹0\./);
    expect(text).not.toMatch(/the host keeps/);
  });

  test("a cancelled booking from before refunds were recorded still renders", async () => {
    const old = booking({ status: "cancelled_by_guest" });
    stubFind(old);
    const res = await request(app(guest)).get(`/trips/${old._id}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("data-refund");
  });
});

describe("POST /trips/:id/cancel", () => {
  test("the guest cancels: transition with the refund and the guest as actor, then back to the booking with a message", async () => {
    const doc = booking();
    stubFind(plain(doc));
    const transition = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({ _id: doc._id });
    const flashes = [];
    const res = await request(app(guest, flashes))
      .post(`/trips/${doc._id}/cancel`)
      .type("form")
      .send({ reason: " Plans changed " });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/trips/${doc._id}`);
    expect(transition).toHaveBeenCalledTimes(1);
    const [id, to, options] = transition.mock.calls[0];
    expect(String(id)).toBe(String(doc._id));
    expect(to).toBe("cancelled_by_guest");
    expect(options).toEqual(
      expect.objectContaining({
        actor: "guest",
        by: guest._id,
        reason: "Plans changed",
        expectStatus: "confirmed",
        refund: expect.objectContaining({
          rule: "flexible_free",
          refundMinor: 800000,
        }),
      }),
    );
    expect(flashes[0][0]).toBe("success");
    expect(flashes[0][1]).toMatch(/cancelled/);
  });

  test("the form cannot choose the actor, the status or the refund", async () => {
    const doc = booking();
    stubFind(plain(doc));
    const transition = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({ _id: doc._id });
    await request(app(guest))
      .post(`/trips/${doc._id}/cancel`)
      .type("form")
      .send({
        actor: "host",
        to: "cancelled_by_host",
        refund: "999999",
        refundMinor: "999999",
        status: "completed",
      });
    const [, to, options] = transition.mock.calls[0];
    expect(to).toBe("cancelled_by_guest");
    expect(options.actor).toBe("guest");
    expect(options.refund.refundMinor).toBe(800000);
  });

  test("a booking that changed meanwhile: back to it with the reason, nothing else", async () => {
    const doc = booking();
    stubFind(plain(doc));
    jest
      .spyOn(reservationsService, "transition")
      .mockRejectedValue(
        new ConflictError("That booking changed. Please reload and try again."),
      );
    const flashes = [];
    const res = await request(app(guest, flashes))
      .post(`/trips/${doc._id}/cancel`)
      .type("form")
      .send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/trips/${doc._id}`);
    expect(flashes).toEqual([
      ["error", "That booking changed. Please reload and try again."],
    ]);
  });

  test("someone else's booking, a missing one, a bad id and a suspended guest are all the same 404", async () => {
    const doc = booking();
    stubFind(plain(doc));
    const transition = jest.spyOn(reservationsService, "transition");
    for (const user of [stranger, admin, { ...guest, status: "suspended" }]) {
      const res = await request(app(user))
        .post(`/trips/${doc._id}/cancel`)
        .type("form")
        .send({});
      expect(res.status).toBe(404);
      expect(res.text).toBe("404: That booking does not exist.");
    }
    stubFind(null);
    expect(
      (
        await request(app(guest))
          .post(`/trips/${new ObjectId()}/cancel`)
          .type("form")
          .send({})
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app(guest))
          .post("/trips/not-an-id/cancel")
          .type("form")
          .send({})
      ).status,
    ).toBe(404);
    expect(transition).not.toHaveBeenCalled();
  });

  test("a signed-out visitor is sent to log in", async () => {
    const res = await request(app(undefined))
      .post(`/trips/${new ObjectId()}/cancel`)
      .type("form")
      .send({});
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test("a reason of 501 characters is a 400 and nothing is cancelled", async () => {
    const doc = booking();
    stubFind(plain(doc));
    const transition = jest.spyOn(reservationsService, "transition");
    const res = await request(app(guest))
      .post(`/trips/${doc._id}/cancel`)
      .type("form")
      .send({ reason: "x".repeat(501) });
    expect(res.status).toBe(400);
    expect(transition).not.toHaveBeenCalled();
  });
});

describe("the host's inbox: cancelling a confirmed stay", () => {
  const confirmedRow = (extra = {}) => ({
    _id: new ObjectId(),
    guest: {
      _id: guest._id,
      displayName: "Ravi",
      username: "ravi",
      createdAt: new Date("2025-03-10T00:00:00Z"),
    },
    host: host._id,
    status: "confirmed",
    ...FUTURE,
    nights: 3,
    guests: 2,
    pricingSnapshot: { totalMinor: 800000, currency: "INR" },
    listingSnapshot: { title: "Sea house", timezone: "Asia/Kolkata" },
    ...extra,
  });

  test("each confirmed stay has a cancel form with a required reason and the consequences spelled out", async () => {
    const row = confirmedRow();
    jest.spyOn(Reservation, "find").mockImplementation((filter) => {
      const rows = filter.status === "pending" ? [] : [row];
      const q = {
        sort: () => q,
        limit: () => q,
        populate: () => q,
        lean: async () => rows,
      };
      return q;
    });
    jest.spyOn(Reservation, "aggregate").mockResolvedValue([]);
    const res = await request(app(host)).get("/host/reservations");
    expect(res.status).toBe(200);
    expect(res.text).toContain(`action="/host/reservations/${row._id}/cancel"`);
    expect(res.text).toMatch(/<textarea[^>]*name="reason"[^>]*required/);
    expect(res.text).toContain("full refund");
    expect(res.text).toContain("counted on your public profile");
  });

  test("the host cancels with a reason: the guest is refunded in full and the counter goes up once", async () => {
    const row = confirmedRow();
    stubFind(row);
    const transition = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({ _id: row._id });
    const update = jest
      .spyOn(User, "updateOne")
      .mockResolvedValue({ modifiedCount: 1 });
    const flashes = [];
    const res = await request(app(host, flashes))
      .post(`/host/reservations/${row._id}/cancel`)
      .type("form")
      .send({ reason: "Pipe burst" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/host/reservations");
    const [, to, options] = transition.mock.calls[0];
    expect(to).toBe("cancelled_by_host");
    expect(options).toEqual(
      expect.objectContaining({
        actor: "host",
        by: host._id,
        reason: "Pipe burst",
        refund: expect.objectContaining({
          rule: "host_cancelled",
          refundMinor: 800000,
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith(
      { _id: host._id },
      { $inc: { hostCancellationCount: 1 } },
    );
    expect(flashes[0][1]).toMatch(/full refund/);
    expect(flashes[0][1]).toMatch(/counted on your profile/);
  });

  test("no reason: the inbox again with the message (400); nothing is cancelled or counted", async () => {
    const row = confirmedRow();
    stubFind(row);
    jest.spyOn(Reservation, "find").mockImplementation(() => {
      const q = {
        sort: () => q,
        limit: () => q,
        populate: () => q,
        lean: async () => [],
      };
      return q;
    });
    jest.spyOn(Reservation, "aggregate").mockResolvedValue([]);
    const transition = jest.spyOn(reservationsService, "transition");
    const update = jest.spyOn(User, "updateOne");
    const res = await request(app(host))
      .post(`/host/reservations/${row._id}/cancel`)
      .type("form")
      .send({ reason: "  " });
    expect(res.status).toBe(400);
    expect(res.text).toContain("Please tell the guest why you are cancelling.");
    expect(transition).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test("a booking that was already cancelled: the inbox again with a 409 and the reason", async () => {
    const row = confirmedRow();
    stubFind(row);
    jest.spyOn(Reservation, "find").mockImplementation(() => {
      const q = {
        sort: () => q,
        limit: () => q,
        populate: () => q,
        lean: async () => [],
      };
      return q;
    });
    jest.spyOn(Reservation, "aggregate").mockResolvedValue([]);
    jest
      .spyOn(reservationsService, "transition")
      .mockRejectedValue(
        new ConflictError(
          "A host cannot change a reservation from cancelled_by_guest to cancelled_by_host.",
        ),
      );
    const update = jest.spyOn(User, "updateOne");
    const res = await request(app(host))
      .post(`/host/reservations/${row._id}/cancel`)
      .type("form")
      .send({ reason: "Sorry" });
    expect(res.status).toBe(409);
    expect(res.text).toContain("cancelled_by_guest");
    expect(update).not.toHaveBeenCalled();
  });

  test("the guest, another host, an admin and a stranger cannot cancel as the host (404)", async () => {
    const row = confirmedRow();
    stubFind(row);
    // the guest may cancel their own booking through the trips page, but not through the host's route as a host
    const transition = jest
      .spyOn(reservationsService, "transition")
      .mockResolvedValue({ _id: row._id });
    for (const user of [stranger, admin]) {
      const res = await request(app(user))
        .post(`/host/reservations/${row._id}/cancel`)
        .type("form")
        .send({ reason: "x" });
      expect(res.status).toBe(404);
    }
    expect(transition).not.toHaveBeenCalled();
    // the guest of the booking, using the host route, is still only a guest: the reservation is cancelled AS A GUEST
    await request(app(guest))
      .post(`/host/reservations/${row._id}/cancel`)
      .type("form")
      .send({ reason: "x" });
    expect(transition.mock.calls[0][1]).toBe("cancelled_by_guest");
    expect(transition.mock.calls[0][2].actor).toBe("guest");
  });
});

describe("the public profile shows the host's cancellations (only when there are some)", () => {
  const base = {
    id: String(guest._id),
    displayName: "Asha",
    username: "asha",
    avatarUrl: null,
    bio: "",
    memberSince: "October 2026",
    listingCount: 2,
    reviewCount: 0,
    reviews: [],
  };
  test("a count above zero is shown; zero is not mentioned", async () => {
    const a = app(undefined);
    a.locals.profile = { ...base, hostCancellationCount: 2 };
    const shown = await request(a).get("/profile-preview");
    expect(shown.text).toMatch(
      /Stays cancelled as a host<\/dt><dd data-host-cancellations>2<\/dd>/,
    );
    a.locals.profile = { ...base, hostCancellationCount: 0 };
    expect((await request(a).get("/profile-preview")).text).not.toContain(
      "cancelled as a host",
    );
  });
});
