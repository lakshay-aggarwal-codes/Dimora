// P12-T01: POST /listings/:id/reviews and the review part of the listing page,
// through the real router, validation, controllers and EJS (layout included),
// in a small Express app with the service and models stubbed (no database).
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Listing = require("../../src/models/listing");
const reviewService = require("../../src/services/reviews");
const reviewRouter = require("../../src/routes/review");
const listingController = require("../../src/controllers/listing");
const wrapAsync = require("../../src/utils/wrapAsync");
const { can } = require("../../src/policies");
const { formatMoney } = require("../../src/utils/money");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");
const pagination = require("../../src/utils/pagination");
const { hiddenFields, listingsUrl } = require("../../src/utils/searchUrl");
const {
  ConflictError,
  NotFoundError,
  ForbiddenError,
} = require("../../src/utils/errors");

afterEach(() => jest.restoreAllMocks());

const ROOT = path.join(__dirname, "..", "..");
const person = (extra = {}) => ({
  _id: new ObjectId(),
  username: "someone",
  role: "member",
  status: "active",
  ...extra,
});
const guest = person({ username: "ravi" });
const LISTING_ID = "64b0f0f0f0f0f0f0f0f0aaaa";
const RESERVATION_ID = "64b0f0f0f0f0f0f0f0f0bbbb";

function app(user, flashes = []) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  a.locals.reviewWindowDays = 30;
  Object.assign(a.locals, {
    fullTitle,
    metaDescription,
    pagination,
    hiddenFields,
    listingsUrl,
    imageUrl: (u) => u,
  });
  a.use(express.urlencoded({ extended: true }));
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
  a.get("/listings/:id", wrapAsync(listingController.showListings));
  a.use("/listings/:id/reviews", reviewRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) =>
    res.status(err.statusCode || 500).json({
      status: err.statusCode || 500,
      code: err.code,
      message: err.message,
    }),
  );
  return a;
}

function stubListing(doc) {
  const query = {
    populate: () => query,
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
  };
  jest.spyOn(Listing, "findById").mockReturnValue(query);
}
const listingDoc = (extra = {}) => ({
  _id: LISTING_ID,
  status: "published",
  title: "Sea house",
  description: "d",
  reviews: [],
  ...extra,
});
const form = (review) => ({ review });

describe("POST /listings/:id/reviews: validation (before anything is stored)", () => {
  test.each([
    ["no reservation", { rating: "5", comment: "Nice" }],
    [
      "a reservation that is not an id",
      { reservation: "abc", rating: "5", comment: "Nice" },
    ],
    ["no rating", { reservation: RESERVATION_ID, comment: "Nice" }],
    ["rating 0", { reservation: RESERVATION_ID, rating: "0", comment: "Nice" }],
    ["rating 6", { reservation: RESERVATION_ID, rating: "6", comment: "Nice" }],
    [
      "rating 4.5",
      { reservation: RESERVATION_ID, rating: "4.5", comment: "Nice" },
    ],
    ["no comment", { reservation: RESERVATION_ID, rating: "5" }],
    [
      "a blank comment",
      { reservation: RESERVATION_ID, rating: "5", comment: "   " },
    ],
    [
      "a comment over 2000 characters",
      { reservation: RESERVATION_ID, rating: "5", comment: "x".repeat(2001) },
    ],
    [
      "an unknown extra field",
      {
        reservation: RESERVATION_ID,
        rating: "5",
        comment: "Nice",
        legacy: "true",
      },
    ],
  ])("%s: 400, nothing submitted", async (_n, review) => {
    const submit = jest.spyOn(reviewService, "submit").mockResolvedValue({});
    const res = await request(app(guest))
      .post(`/listings/${LISTING_ID}/reviews`)
      .type("form")
      .send(form(review));
    expect(res.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  test("an empty body is a 400 too", async () => {
    const res = await request(app(guest))
      .post(`/listings/${LISTING_ID}/reviews`)
      .type("form")
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /listings/:id/reviews: the service decides", () => {
  const good = form({
    reservation: RESERVATION_ID,
    rating: "4",
    comment: "Lovely",
  });

  test("success: the arguments, a message, and back to the listing page", async () => {
    const submit = jest.spyOn(reviewService, "submit").mockResolvedValue({});
    jest.spyOn(Listing, "exists").mockResolvedValue({ _id: LISTING_ID });
    const flashes = [];
    const res = await request(app(guest, flashes))
      .post(`/listings/${LISTING_ID}/reviews`)
      .type("form")
      .send(good);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/listings/${LISTING_ID}`);
    expect(submit).toHaveBeenCalledWith({
      user: guest,
      listingId: LISTING_ID,
      reservationId: RESERVATION_ID,
      rating: "4",
      comment: "Lovely",
      windowDays: 30,
    });
    expect(flashes[0][0]).toBe("success");
  });

  test("a listing that is no longer public: back to the booking page instead", async () => {
    jest.spyOn(reviewService, "submit").mockResolvedValue({});
    jest.spyOn(Listing, "exists").mockResolvedValue(null);
    const res = await request(app(guest))
      .post(`/listings/${LISTING_ID}/reviews`)
      .type("form")
      .send(good);
    expect(res.headers.location).toBe(`/trips/${RESERVATION_ID}`);
  });

  test.each([
    [new NotFoundError("That stay does not exist."), 404, "not_found"],
    [
      new ConflictError("You can review a stay once it is completed.", {
        code: "stay_not_completed",
      }),
      409,
      "stay_not_completed",
    ],
    [
      new ConflictError("You have already reviewed this stay.", {
        code: "already_reviewed",
      }),
      409,
      "already_reviewed",
    ],
    [
      new ConflictError(
        "Reviews can be written up to 30 days after check-out.",
        { code: "review_window_closed" },
      ),
      409,
      "review_window_closed",
    ],
    [
      new ForbiddenError("You cannot review your own listing.", {
        code: "own_listing",
      }),
      403,
      "own_listing",
    ],
  ])(
    "a refusal from the service reaches the guest as its own status and code",
    async (error, status, code) => {
      jest.spyOn(reviewService, "submit").mockRejectedValue(error);
      const res = await request(app(guest))
        .post(`/listings/${LISTING_ID}/reviews`)
        .type("form")
        .send(good);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
    },
  );

  test("a suspended member is refused by the policy before the service is called", async () => {
    const submit = jest.spyOn(reviewService, "submit").mockResolvedValue({});
    const res = await request(app({ ...guest, status: "suspended" }))
      .post(`/listings/${LISTING_ID}/reviews`)
      .type("form")
      .send(good);
    expect(res.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });

  test("signed out: a redirect to log in", async () => {
    const submit = jest.spyOn(reviewService, "submit").mockResolvedValue({});
    const res = await request(app(undefined))
      .post(`/listings/${LISTING_ID}/reviews`)
      .type("form")
      .send(good);
    expect([301, 302, 303]).toContain(res.status);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("the review part of the listing page", () => {
  test("a guest with a stay to review sees the form with the reservation inside, nothing pre-selected", async () => {
    stubListing(listingDoc());
    const find = jest.spyOn(reviewService, "findReviewable").mockResolvedValue({
      reservationId: RESERVATION_ID,
      reviewUntil: new Date(),
    });
    const res = await request(app(guest)).get(`/listings/${LISTING_ID}`);
    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ user: guest, windowDays: 30 }),
    );
    expect(res.text).toContain(
      `name="review[reservation]" value="${RESERVATION_ID}"`,
    );
    const radios = res.text.match(/<input type="radio"[^>]*>/g) || [];
    expect(radios).toHaveLength(5);
    for (const radio of radios) {
      expect(radio).toMatch(/\brequired\b/);
      expect(radio).not.toMatch(/\bchecked\b/);
    }
    expect(res.text).toContain("Submit review");
  });

  test("a signed-in member with no stay to review sees an explanation, not a form", async () => {
    stubListing(listingDoc());
    jest.spyOn(reviewService, "findReviewable").mockResolvedValue(null);
    const res = await request(app(guest)).get(`/listings/${LISTING_ID}`);
    expect(res.text).not.toContain("detail-review-form");
    expect(res.text).not.toContain("Submit review");
    expect(res.text).toContain("Reviews come from guests who stayed here.");
  });

  test("a visitor who is signed out sees neither, and nothing is looked up for them", async () => {
    stubListing(listingDoc());
    const find = jest
      .spyOn(reviewService, "findReviewable")
      .mockResolvedValue(null);
    const res = await request(app(undefined)).get(`/listings/${LISTING_ID}`);
    expect(res.text).not.toContain("detail-review-form");
    expect(res.text).not.toContain("Reviews come from guests");
    expect(find).not.toHaveBeenCalled();
  });

  test("the host's guest preview offers no form", async () => {
    stubListing(listingDoc({ owner: { _id: guest._id } }));
    const find = jest
      .spyOn(reviewService, "findReviewable")
      .mockResolvedValue({ reservationId: RESERVATION_ID });
    const res = await request(app(guest)).get(
      `/listings/${LISTING_ID}?preview=1`,
    );
    expect(res.status).toBe(200);
    expect(find).not.toHaveBeenCalled();
    expect(res.text).not.toContain("Submit review");
  });

  test("a review from before bookings existed carries a note; a review of a stay does not", async () => {
    stubListing(
      listingDoc({
        reviews: [
          {
            _id: "64b0f0f0f0f0f0f0f0f0e001",
            rating: 4,
            comment: "Old one <b>x</b>",
            legacy: true,
            author: { _id: "64b0f0f0f0f0f0f0f0f0ffff", username: "old" },
          },
          {
            _id: "64b0f0f0f0f0f0f0f0f0e002",
            rating: 5,
            comment: "New one",
            legacy: false,
            reservation: RESERVATION_ID,
            author: { _id: "64b0f0f0f0f0f0f0f0f0fffe", username: "new" },
          },
        ],
      }),
    );
    const res = await request(app(undefined)).get(`/listings/${LISTING_ID}`);
    expect(
      res.text.match(/Posted before bookings existed on Dimora/g),
    ).toHaveLength(1);
    expect(res.text).toContain("Old one &lt;b&gt;x&lt;/b&gt;");
    expect(res.text.indexOf("Old one")).toBeLessThan(
      res.text.indexOf("Posted before bookings"),
    );
    expect(res.text.indexOf("Posted before bookings")).toBeLessThan(
      res.text.indexOf("New one"),
    );
  });
});

describe("the listing page: newest first, summary from the stored totals (P12-T02)", () => {
  const rv = (n, createdAt, extra = {}) => ({
    _id: `64b0f0f0f0f0f0f0f0f0e00${n}`,
    rating: 3,
    comment: `Review number ${n}`,
    createdAt,
    author: { _id: "64b0f0f0f0f0f0f0f0f0ffff", username: `guest${n}` },
    ...extra,
  });

  test("reviews are listed newest first, whatever order they are stored in", async () => {
    stubListing(
      listingDoc({
        reviews: [
          rv(1, new Date("2026-01-05")),
          rv(2, new Date("2026-03-05")),
          rv(3, new Date("2026-02-05")),
        ],
      }),
    );
    const text = (await request(app(undefined)).get(`/listings/${LISTING_ID}`))
      .text;
    const at = (n) => text.indexOf(`Review number ${n}`);
    expect(at(2)).toBeGreaterThan(-1);
    expect(at(2)).toBeLessThan(at(3));
    expect(at(3)).toBeLessThan(at(1));
    expect(text).toContain("Mar 2026");
  });

  test("a review without a date is dated by its id and sorts with the rest", async () => {
    stubListing(
      listingDoc({
        reviews: [rv(1, undefined), rv(2, new Date("2090-01-01"))],
      }),
    );
    const text = (await request(app(undefined)).get(`/listings/${LISTING_ID}`))
      .text;
    expect(text.indexOf("Review number 2")).toBeLessThan(
      text.indexOf("Review number 1"),
    );
  });

  test("the summary is the stored total and count, not the reviews that happen to be loaded", async () => {
    stubListing(
      listingDoc({
        ratingSum: 47,
        ratingCount: 10,
        ratingAvg: 4.7,
        reviews: [rv(1, new Date("2026-01-05"))],
      }),
    );
    const text = (await request(app(undefined)).get(`/listings/${LISTING_ID}`))
      .text;
    expect(text).toContain("Rated 4.7 out of 5 from 10 reviews");
  });

  test("a listing with no totals yet is counted from its reviews", async () => {
    stubListing(
      listingDoc({
        reviews: [
          rv(1, new Date("2026-01-05"), { rating: 4 }),
          rv(2, new Date("2026-01-06"), { rating: 5 }),
        ],
      }),
    );
    const text = (await request(app(undefined)).get(`/listings/${LISTING_ID}`))
      .text;
    expect(text).toContain("Rated 4.5 out of 5 from 2 reviews");
  });

  test("no reviews: no summary, a plain sentence", async () => {
    stubListing(listingDoc());
    const text = (await request(app(undefined)).get(`/listings/${LISTING_ID}`))
      .text;
    expect(text).toContain("No reviews yet.");
    expect(text).not.toContain("review-summary");
  });
});
