// P12-T03: editing a review and the host's reply, through the real router,
// policies, validation, controllers and EJS (layout included), in a small
// Express app with the service and the models stubbed (no database).
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const reviewService = require("../../src/services/reviews");
const reviewRouter = require("../../src/routes/review");
const listingController = require("../../src/controllers/listing");
const wrapAsync = require("../../src/utils/wrapAsync");
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
const guest = person({ username: "ravi" });
const host = person({ username: "asha" });
const stranger = person({ username: "stranger" });
const LISTING_ID = "64b0f0f0f0f0f0f0f0f0aaaa";
const REVIEW_ID = "64b0f0f0f0f0f0f0f0f0cccc";
const RESERVATION_ID = "64b0f0f0f0f0f0f0f0f0bbbb";
const BASE = `/listings/${LISTING_ID}/reviews/${REVIEW_ID}`;

function app(user, flashes = []) {
  const a = express();
  a.set("view engine", "ejs");
  a.set("views", path.join(ROOT, "views"));
  a.engine("ejs", ejsMate);
  a.locals.reviewWindowDays = 30;
  a.locals.reviewEditDays = 7;
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

/** The listing as the authorize() loader and the listing page ask for it. */
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
  owner: { _id: host._id, username: "asha" },
  reviews: [],
  ...extra,
});
const reviewDoc = (extra = {}) => ({
  _id: REVIEW_ID,
  rating: 4,
  comment: "Nice flat.",
  author: { _id: guest._id, username: "ravi" },
  reservation: RESERVATION_ID,
  createdAt: new Date(),
  ...extra,
});
function stubStored(review = reviewDoc()) {
  stubListing(listingDoc({ reviews: [REVIEW_ID] }));
  jest.spyOn(Review, "findById").mockResolvedValue(review);
}

describe("PUT /listings/:id/reviews/:reviewId (the author edits)", () => {
  const good = { review: { rating: "2", comment: "Changed my mind." } };
  const put = (user, body = good, flashes) =>
    request(app(user, flashes)).put(BASE).type("form").send(body);

  test("success: the arguments, a message, and back to the review on the listing page", async () => {
    stubStored();
    const edit = jest
      .spyOn(reviewService, "edit")
      .mockResolvedValue({ review: reviewDoc(), changed: true });
    const flashes = [];
    const res = await put(guest, good, flashes);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `/listings/${LISTING_ID}#review-${REVIEW_ID}`,
    );
    expect(edit).toHaveBeenCalledWith({
      user: guest,
      listingId: LISTING_ID,
      reviewId: REVIEW_ID,
      rating: "2",
      comment: "Changed my mind.",
      editDays: 7,
    });
    expect(flashes).toEqual([["success", "Your review was updated."]]);
  });

  test("from the booking page the guest goes back to the booking", async () => {
    stubStored();
    jest
      .spyOn(reviewService, "edit")
      .mockResolvedValue({ review: reviewDoc(), changed: true });
    const res = await put(guest, {
      review: { ...good.review, from: "trip" },
    });
    expect(res.headers.location).toBe(`/trips/${RESERVATION_ID}#review`);
  });

  test("nothing changed: a different message", async () => {
    stubStored();
    jest
      .spyOn(reviewService, "edit")
      .mockResolvedValue({ review: reviewDoc(), changed: false });
    const flashes = [];
    await put(guest, good, flashes);
    expect(flashes).toEqual([["success", "No changes."]]);
  });

  test.each([
    ["no rating", { comment: "Nice" }],
    ["rating 0", { rating: "0", comment: "Nice" }],
    ["rating 6", { rating: "6", comment: "Nice" }],
    ["rating 4.5", { rating: "4.5", comment: "Nice" }],
    ["no comment", { rating: "3" }],
    ["a blank comment", { rating: "3", comment: "   " }],
    ["a comment over 2000", { rating: "3", comment: "x".repeat(2001) }],
    [
      "a reservation id (not editable)",
      { rating: "3", comment: "ok", reservation: RESERVATION_ID },
    ],
    ["a status field", { rating: "3", comment: "ok", status: "hidden" }],
    [
      "a back-link that is not a page of ours",
      { rating: "3", comment: "ok", from: "http://evil.example" },
    ],
  ])("%s: 400, nothing edited", async (_n, review) => {
    stubStored();
    const edit = jest.spyOn(reviewService, "edit").mockResolvedValue({});
    const res = await put(guest, { review });
    expect(res.status).toBe(400);
    expect(edit).not.toHaveBeenCalled();
  });

  test("an empty body is a 400 too", async () => {
    stubStored();
    const res = await put(guest, {});
    expect(res.status).toBe(400);
  });

  test("another member and the host get a 403, before the service is called", async () => {
    const edit = jest.spyOn(reviewService, "edit").mockResolvedValue({});
    for (const user of [stranger, host]) {
      stubStored();
      const res = await put(user);
      expect(res.status).toBe(403);
    }
    expect(edit).not.toHaveBeenCalled();
  });

  test("an admin cannot rewrite someone's review", async () => {
    stubStored();
    const edit = jest.spyOn(reviewService, "edit").mockResolvedValue({});
    const res = await put(person({ role: "admin" }));
    expect(res.status).toBe(403);
    expect(edit).not.toHaveBeenCalled();
  });

  test("a review that is not on this listing is a 404", async () => {
    stubListing(listingDoc({ reviews: [] }));
    const lookup = jest.spyOn(Review, "findById");
    const res = await put(guest);
    expect(res.status).toBe(404);
    expect(lookup).not.toHaveBeenCalled();
  });

  test("the window closing reaches the guest as a 409 with its code", async () => {
    stubStored();
    jest.spyOn(reviewService, "edit").mockRejectedValue(
      new ConflictError(
        "A review can be edited for 7 days after it was posted.",
        {
          code: "review_edit_window_closed",
        },
      ),
    );
    const res = await put(guest);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("review_edit_window_closed");
  });

  test("signed out: a redirect to log in, nothing edited", async () => {
    const edit = jest.spyOn(reviewService, "edit").mockResolvedValue({});
    const res = await put(undefined);
    expect([301, 302, 303]).toContain(res.status);
    expect(edit).not.toHaveBeenCalled();
  });
});

describe("POST and DELETE .../reviews/:reviewId/reply (the host)", () => {
  const post = (user, body = { reply: { text: "Thank you!" } }, flashes) =>
    request(app(user, flashes)).post(`${BASE}/reply`).type("form").send(body);

  test("the host's reply reaches the service with the listing the policy was decided on", async () => {
    const listing = listingDoc({ reviews: [REVIEW_ID] });
    stubListing(listing);
    const reply = jest.spyOn(reviewService, "reply").mockResolvedValue({});
    const flashes = [];
    const res = await post(host, undefined, flashes);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `/listings/${LISTING_ID}#review-${REVIEW_ID}`,
    );
    expect(reply).toHaveBeenCalledWith({
      user: host,
      listing,
      reviewId: REVIEW_ID,
      text: "Thank you!",
    });
    expect(flashes).toEqual([["success", "Your reply was posted."]]);
  });

  test.each([
    ["no reply", {}],
    ["no text", { reply: {} }],
    ["a blank text", { reply: { text: "   " } }],
    ["a text over 1000", { reply: { text: "x".repeat(1001) } }],
    ["an extra field", { reply: { text: "ok", author: "someone" } }],
  ])("%s: 400, nothing stored", async (_n, body) => {
    stubListing(listingDoc({ reviews: [REVIEW_ID] }));
    const reply = jest.spyOn(reviewService, "reply").mockResolvedValue({});
    const res = await post(host, body);
    expect(res.status).toBe(400);
    expect(reply).not.toHaveBeenCalled();
  });

  test("the guest, another member and an admin get a 403", async () => {
    const reply = jest.spyOn(reviewService, "reply").mockResolvedValue({});
    const remove = jest
      .spyOn(reviewService, "removeReply")
      .mockResolvedValue(true);
    for (const user of [guest, stranger, person({ role: "admin" })]) {
      stubListing(listingDoc({ reviews: [REVIEW_ID] }));
      expect((await post(user)).status).toBe(403);
      stubListing(listingDoc({ reviews: [REVIEW_ID] }));
      const del = await request(app(user)).delete(`${BASE}/reply`);
      expect(del.status).toBe(403);
    }
    expect(reply).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("a missing listing is a 404; signed out goes to the login page", async () => {
    stubListing(null);
    expect((await post(host)).status).toBe(404);
    const reply = jest.spyOn(reviewService, "reply").mockResolvedValue({});
    const res = await post(undefined);
    expect([301, 302, 303]).toContain(res.status);
    expect(reply).not.toHaveBeenCalled();
  });

  test("DELETE takes the reply back, and says so when there was none", async () => {
    stubListing(listingDoc({ reviews: [REVIEW_ID] }));
    const remove = jest
      .spyOn(reviewService, "removeReply")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const flashes = [];
    const first = await request(app(host, flashes)).delete(`${BASE}/reply`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(
      `/listings/${LISTING_ID}#review-${REVIEW_ID}`,
    );
    await request(app(host, flashes)).delete(`${BASE}/reply`);
    expect(flashes).toEqual([
      ["success", "Your reply was removed."],
      ["success", "No reply to remove."],
    ]);
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ user: host, reviewId: REVIEW_ID }),
    );
  });
});

describe("the review cards on the listing page (P12-T03)", () => {
  const page = (user) => request(app(user)).get(`/listings/${LISTING_ID}`);
  const withReviews = (...reviews) => {
    stubListing(listingDoc({ reviews }));
    jest.spyOn(reviewService, "findReviewable").mockResolvedValue(null);
  };

  test("the author sees an edit form with the stars and the comment filled in, sent with PUT", async () => {
    withReviews(reviewDoc({ rating: 4, comment: "Nice <b>flat</b>." }));
    const res = await page(guest);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Edit your review");
    expect(res.text).toContain(`action="${BASE}?_method=PUT"`);
    const radios =
      res.text.match(
        /<input type="radio"[^>]*name="review\[rating\]"[^>]*>/g,
      ) || [];
    expect(radios).toHaveLength(5);
    expect(radios.filter((r) => /\bchecked\b/.test(r))).toHaveLength(1);
    expect(radios.find((r) => /\bchecked\b/.test(r))).toContain('value="4"');
    expect(res.text).toContain(">Nice &lt;b&gt;flat&lt;/b&gt;.</textarea>");
    expect(res.text).not.toContain("Nice <b>flat</b>.");
    // each edit form has its own ids
    expect(res.text).toContain(`id="edit-${REVIEW_ID}-comment"`);
    expect(res.text).toContain('name="review[from]" value="listing"');
    // no reply tools for the guest
    expect(res.text).not.toContain("Reply to this review");
  });

  test("past the edit window there is no edit form", async () => {
    withReviews(
      reviewDoc({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }),
    );
    const res = await page(guest);
    expect(res.text).not.toContain("Edit your review");
  });

  test("somebody else's review, a visitor and the host get no edit form", async () => {
    for (const user of [stranger, host, undefined]) {
      withReviews(reviewDoc());
      const res = await page(user);
      expect(res.text).not.toContain("Edit your review");
    }
  });

  test("an edited review says so", async () => {
    withReviews(reviewDoc({ editedAt: new Date() }));
    const res = await page(undefined);
    expect(res.text).toMatch(
      /<p class="small text-body-secondary mb-2">Edited<\/p>/,
    );
    withReviews(reviewDoc());
    expect((await page(undefined)).text).not.toMatch(/mb-2">Edited</);
  });

  test("the host sees a reply form on a review without a reply", async () => {
    withReviews(reviewDoc());
    const res = await page(host);
    expect(res.text).toContain("Reply to this review");
    expect(res.text).toContain(`action="${BASE}/reply"`);
    expect(res.text).toContain('name="reply[text]"');
    expect(res.text).toContain("Post reply");
    expect(res.text).not.toContain("Remove reply");
    expect(res.text).not.toContain("Response from the host");
  });

  test("a reply is shown to everybody, escaped, as a response from the host", async () => {
    const reply = {
      text: "Thanks <script>alert(1)</script>",
      createdAt: new Date(),
    };
    for (const user of [undefined, guest, stranger]) {
      withReviews(reviewDoc({ reply }));
      const res = await page(user);
      expect(res.text).toContain("Response from the host");
      expect(res.text).toContain(
        "Thanks &lt;script&gt;alert(1)&lt;/script&gt;",
      );
      expect(res.text).not.toContain("<script>alert(1)</script>");
      expect(res.text).not.toContain("Reply to this review");
      expect(res.text).not.toContain("Remove reply");
    }
  });

  test("the host can edit or remove their reply", async () => {
    withReviews(
      reviewDoc({ reply: { text: "Thank you!", createdAt: new Date() } }),
    );
    const res = await page(host);
    expect(res.text).toContain("Edit your reply");
    expect(res.text).toContain("Save reply");
    expect(res.text).toContain(">Thank you!</textarea>");
    expect(res.text).toContain(`action="${BASE}/reply?_method=DELETE"`);
    expect(res.text).toContain("Remove reply");
  });

  test("the host's guest preview shows the reply but none of the host's tools", async () => {
    withReviews(
      reviewDoc({ reply: { text: "Thank you!", createdAt: new Date() } }),
    );
    const res = await request(app(host)).get(
      `/listings/${LISTING_ID}?preview=1`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("Response from the host");
    expect(res.text).not.toContain("Edit your reply");
    expect(res.text).not.toContain("Remove reply");
  });
});
