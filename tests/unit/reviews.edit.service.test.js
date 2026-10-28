// P12-T03: a guest edits their review inside the edit window, and the host
// replies. In-memory fakes, no database; the listing's update pipelines are run
// by tests/helpers/pipelineEval.js. The real database is not involved.
const { ObjectId } = require("mongoose").Types;
const {
  createReviewService,
  editDeadline,
  isEditable,
  parseReply,
  DEFAULT_EDIT_DAYS,
  REPLY_MAX,
} = require("../../src/services/reviews");
const ratings = require("../../src/services/ratings");
const {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../../src/utils/errors");
const { applyPipeline } = require("../helpers/pipelineEval");

afterEach(() => jest.restoreAllMocks());

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-20T06:30:00Z");
const GUEST = { _id: new ObjectId(), status: "active", role: "member" };
const HOST = { _id: new ObjectId(), status: "active", role: "member" };
const OTHER = { _id: new ObjectId(), status: "active", role: "member" };
const LISTING_ID = new ObjectId();

const clone = (doc) =>
  doc ? { ...doc, reply: doc.reply && { ...doc.reply } } : doc;

/** Applies the few operators the service uses: $set (dotted keys too) and $unset. */
function applyUpdate(doc, update) {
  for (const [key, value] of Object.entries(update.$set || {})) {
    if (key.includes(".")) {
      const [head, tail] = key.split(".");
      doc[head] = { ...(doc[head] || {}), [tail]: value };
    } else doc[key] = value;
  }
  for (const key of Object.keys(update.$unset || {})) delete doc[key];
}

function matches(doc, filter) {
  if (filter._id !== undefined && String(doc._id) !== String(filter._id))
    return false;
  if (
    filter.author !== undefined &&
    String(doc.author) !== String(filter.author)
  )
    return false;
  if (filter.status && filter.status.$ne && doc.status === filter.status.$ne)
    return false;
  if (typeof filter.status === "string" && doc.status !== filter.status)
    return false;
  if (filter.createdAt && filter.createdAt.$gte) {
    if (!doc.createdAt || doc.createdAt < filter.createdAt.$gte) return false;
  }
  if (filter["reply.text"] && filter["reply.text"].$exists) {
    if (!(doc.reply && doc.reply.text)) return false;
  }
  return true;
}

function reviewDoc(extra = {}) {
  return {
    _id: new ObjectId(),
    author: GUEST._id,
    listing: LISTING_ID,
    reservation: new ObjectId(),
    rating: 4,
    comment: "Nice flat.",
    status: "visible",
    legacy: false,
    createdAt: new Date(NOW.getTime() - 2 * DAY),
    ...extra,
  };
}

function setup({ review = reviewDoc(), listingExtra = {}, editDays } = {}) {
  const reviews = [review];
  const listing = {
    _id: LISTING_ID,
    owner: HOST._id,
    reviews: [review._id],
    ratingSum: 4 + 5, // this review (4) and one other (5)
    ratingCount: 2,
    ratingAvg: 4.5,
    ...listingExtra,
  };
  const ReviewModel = {
    docs: reviews,
    findOne: jest.fn(async (filter) => {
      const found = reviews.find((r) => matches(r, filter));
      return found ? clone(found) : null;
    }),
    findOneAndUpdate: jest.fn(async (filter, update, options = {}) => {
      await Promise.resolve(); // a real write yields
      const found = reviews.find((r) => matches(r, filter));
      if (!found) return null;
      const before = clone(found);
      applyUpdate(found, update);
      return options.new ? clone(found) : before;
    }),
    updateOne: jest.fn(async (filter, update) => {
      const found = reviews.find((r) => matches(r, filter));
      if (found) applyUpdate(found, update);
      return { matchedCount: found ? 1 : 0 };
    }),
    exists: jest.fn(async (filter) =>
      reviews.some((r) => matches(r, filter)) ? { _id: 1 } : null,
    ),
  };
  const state = { listing };
  const ListingModel = {
    state,
    updateOne: jest.fn(async (filter, update) => {
      state.listing = applyPipeline(state.listing, update);
      return { matchedCount: 1 };
    }),
  };
  const service = createReviewService({
    ReviewModel,
    ListingModel,
    ReservationModel: {},
    ...(editDays ? { editDays } : {}),
  });
  const edit = (over = {}) =>
    service.edit({
      user: GUEST,
      listingId: String(LISTING_ID),
      reviewId: String(review._id),
      rating: "2",
      comment: "Changed my mind.",
      now: NOW,
      ...over,
    });
  return { service, edit, review, reviews, listing, ReviewModel, ListingModel };
}

const denied = async (promise, Type, code) => {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(Type);
  if (code) expect(err.code).toBe(code);
  return err;
};

describe("editDeadline / isEditable", () => {
  test("seven days after posting by default; the exact moment still counts", () => {
    expect(DEFAULT_EDIT_DAYS).toBe(7);
    const posted = new Date("2026-11-01T10:00:00Z");
    const review = { _id: new ObjectId(), createdAt: posted };
    expect(editDeadline(review)).toEqual(new Date("2026-11-08T10:00:00Z"));
    expect(isEditable(review, new Date("2026-11-08T10:00:00Z"))).toBe(true);
    expect(isEditable(review, new Date("2026-11-08T10:00:00.001Z"))).toBe(
      false,
    );
    expect(isEditable(review, new Date("2026-11-03T00:00:00Z"), 1)).toBe(false);
  });
  test("a review with no createdAt is dated by its id; a hidden one is never editable", () => {
    const review = { _id: new ObjectId() };
    expect(isEditable(review, new Date())).toBe(true);
    expect(isEditable(review, new Date(Date.now() + 8 * DAY))).toBe(false);
    expect(isEditable({ ...review, status: "hidden" }, new Date())).toBe(false);
    expect(isEditable(null)).toBe(false);
    expect(editDeadline({})).toBeNull();
  });
});

describe("parseReply", () => {
  test("trims; refuses blank, non-text and over-long replies", () => {
    expect(parseReply("  Thanks!  ")).toBe("Thanks!");
    expect(parseReply("x".repeat(REPLY_MAX))).toHaveLength(REPLY_MAX);
    for (const bad of [
      undefined,
      null,
      5,
      "",
      "   ",
      "x".repeat(REPLY_MAX + 1),
    ]) {
      expect(() => parseReply(bad)).toThrow(ValidationError);
    }
  });
});

describe("edit: the author changes their own review", () => {
  test("rating and comment change, editedAt is set, the totals move by the difference (one update)", async () => {
    const t = setup();
    const out = await t.edit({ rating: "2", comment: "  Changed my mind. " });
    expect(out.changed).toBe(true);
    expect(out.review).toMatchObject({
      rating: 2,
      comment: "Changed my mind.",
    });
    expect(t.reviews[0]).toMatchObject({
      rating: 2,
      comment: "Changed my mind.",
      editedAt: NOW,
    });
    expect(t.ListingModel.updateOne).toHaveBeenCalledTimes(1);
    expect(t.ListingModel.state.listing).toMatchObject({
      ratingSum: 7,
      ratingCount: 2,
    });
    expect(t.ListingModel.state.listing.ratingAvg).toBeCloseTo(3.5, 12);
    expect(t.ListingModel.state.listing.reviews).toEqual([t.review._id]);
  });

  test("only the comment changes: the totals are not touched", async () => {
    const t = setup();
    const out = await t.edit({ rating: "4", comment: "More detail." });
    expect(out.changed).toBe(true);
    expect(t.ListingModel.updateOne).not.toHaveBeenCalled();
    expect(t.reviews[0].editedAt).toEqual(NOW);
  });

  test("nothing changed: no write, no editedAt", async () => {
    const t = setup();
    const out = await t.edit({ rating: "4", comment: "Nice flat." });
    expect(out.changed).toBe(false);
    expect(t.ReviewModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(t.reviews[0].editedAt).toBeUndefined();
  });

  test("the compare-and-set carries the author, the visible status and the window cut-off", async () => {
    const t = setup();
    await t.edit();
    const [filter, update, options] =
      t.ReviewModel.findOneAndUpdate.mock.calls[0];
    expect(String(filter.author)).toBe(String(GUEST._id));
    expect(filter.status).toEqual({ $ne: "hidden" });
    expect(filter.createdAt.$gte).toEqual(new Date(NOW.getTime() - 7 * DAY));
    expect(update.$set).toMatchObject({ rating: 2, editedAt: NOW });
    expect(options.new).toBe(false);
  });

  test("the window is configurable per service and per call", async () => {
    const old = reviewDoc({ createdAt: new Date(NOW.getTime() - 10 * DAY) });
    await denied(
      setup({ review: old }).edit(),
      ConflictError,
      "review_edit_window_closed",
    );
    const t = setup({ review: old, editDays: 14 });
    expect((await t.edit()).changed).toBe(true);
    const t2 = setup({ review: old });
    expect((await t2.edit({ editDays: 30 })).changed).toBe(true);
  });

  test("past the window: 409 with its own code, nothing written", async () => {
    const t = setup({
      review: reviewDoc({ createdAt: new Date(NOW.getTime() - 8 * DAY) }),
    });
    const err = await denied(
      t.edit(),
      ConflictError,
      "review_edit_window_closed",
    );
    expect(err.message).toMatch(/7 days/);
    expect(t.ReviewModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(t.ListingModel.updateOne).not.toHaveBeenCalled();
  });

  test("exactly seven days after posting is still allowed", async () => {
    const t = setup({
      review: reviewDoc({ createdAt: new Date(NOW.getTime() - 7 * DAY) }),
    });
    expect((await t.edit()).changed).toBe(true);
  });

  test.each([
    ["somebody else's review", { user: OTHER }],
    ["a review of another listing", { listingId: String(new ObjectId()) }],
    ["a review id that is not an id", { reviewId: "nope" }],
    ["a review that does not exist", { reviewId: String(new ObjectId()) }],
  ])("%s: 404, and nothing is written", async (_n, over) => {
    const t = setup();
    await denied(t.edit(over), NotFoundError);
    expect(t.ReviewModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("a hidden review looks like one that does not exist", async () => {
    const t = setup({ review: reviewDoc({ status: "hidden" }) });
    await denied(t.edit(), NotFoundError);
  });

  test("a suspended or signed-out author is refused before anything is read", async () => {
    const t = setup();
    await denied(
      t.edit({ user: { ...GUEST, status: "suspended" } }),
      ForbiddenError,
      "account_not_active",
    );
    await denied(
      t.edit({ user: undefined }),
      ForbiddenError,
      "account_not_active",
    );
    expect(t.ReviewModel.findOne).not.toHaveBeenCalled();
  });

  test.each([
    ["no rating", { rating: undefined }],
    ["rating 0", { rating: "0" }],
    ["rating 6", { rating: "6" }],
    ["rating 3.5", { rating: "3.5" }],
    ["a blank comment", { comment: "   " }],
    ["no comment", { comment: undefined }],
    ["a comment over 2000", { comment: "x".repeat(2001) }],
  ])("%s: 400 before anything is looked up", async (_n, over) => {
    const t = setup();
    await denied(t.edit(over), ValidationError);
    expect(t.ReviewModel.findOne).not.toHaveBeenCalled();
  });

  test("hidden or past the window between the read and the write: 409, totals untouched", async () => {
    const t = setup();
    t.ReviewModel.findOneAndUpdate.mockResolvedValueOnce(null);
    await denied(t.edit(), ConflictError, "review_edit_window_closed");
    expect(t.ListingModel.updateOne).not.toHaveBeenCalled();
  });

  test("the totals update fails: the review is put back and the error reaches the caller", async () => {
    const t = setup();
    t.ListingModel.updateOne.mockRejectedValueOnce(new Error("db down"));
    await expect(t.edit()).rejects.toThrow("db down");
    expect(t.reviews[0]).toMatchObject({ rating: 4, comment: "Nice flat." });
    expect(t.reviews[0].editedAt).toBeUndefined();
  });

  test("the totals update fails on a review that was edited before: its old editedAt comes back", async () => {
    const before = new Date(NOW.getTime() - DAY);
    const t = setup({ review: reviewDoc({ editedAt: before }) });
    t.ListingModel.updateOne.mockRejectedValueOnce(new Error("db down"));
    await expect(t.edit()).rejects.toThrow("db down");
    expect(t.reviews[0].editedAt).toEqual(before);
  });

  test("hidden while the totals were being changed: they are repaired from the reviews", async () => {
    const t = setup();
    const repair = jest
      .spyOn(ratings, "recomputeRatings")
      .mockResolvedValue({});
    t.ListingModel.updateOne.mockImplementationOnce(async () => {
      t.reviews[0].status = "hidden"; // an admin hides it in between
      return { matchedCount: 1 };
    });
    await t.edit();
    expect(repair).toHaveBeenCalledTimes(1);
  });

  test("two edits at the same moment: the totals match the review that ends up stored", async () => {
    const t = setup();
    await Promise.all([t.edit({ rating: "1" }), t.edit({ rating: "5" })]);
    const stored = t.reviews[0].rating;
    expect(t.ListingModel.state.listing.ratingSum).toBe(5 + stored);
    expect(t.ListingModel.state.listing.ratingCount).toBe(2);
  });
});

describe("reply: the host answers a review", () => {
  const reply = (t, over = {}) =>
    t.service.reply({
      user: HOST,
      listing: t.listing,
      reviewId: String(t.review._id),
      text: "  Thank you for staying!  ",
      now: NOW,
      ...over,
    });

  test("the first reply stores text, author and date", async () => {
    const t = setup();
    const saved = await reply(t);
    expect(saved.reply).toMatchObject({
      text: "Thank you for staying!",
      createdAt: NOW,
    });
    expect(String(saved.reply.author)).toBe(String(HOST._id));
    expect(saved.reply.editedAt).toBeUndefined();
  });

  test("replying again replaces the text, keeps the first date, records editedAt", async () => {
    const t = setup();
    await reply(t);
    const later = new Date(NOW.getTime() + DAY);
    const saved = await reply(t, { text: "Updated answer.", now: later });
    expect(saved.reply).toMatchObject({
      text: "Updated answer.",
      createdAt: NOW,
      editedAt: later,
    });
  });

  test("it never touches the rating totals", async () => {
    const t = setup();
    await reply(t);
    expect(t.ListingModel.updateOne).not.toHaveBeenCalled();
  });

  test.each([
    ["the guest", { user: GUEST }],
    ["another member", { user: OTHER }],
    ["a suspended host", { user: { ...HOST, status: "suspended" } }],
    ["a signed-out visitor", { user: undefined }],
  ])("%s: 403, nothing stored", async (_n, over) => {
    const t = setup();
    await denied(reply(t, over), ForbiddenError, "not_host");
    expect(t.reviews[0].reply).toBeUndefined();
  });

  test("a listing that is not the host's: 403", async () => {
    const t = setup({ listingExtra: { owner: OTHER._id } });
    await denied(reply(t), ForbiddenError, "not_host");
  });

  test("a review that is not on the listing (or is hidden, so it left the list): 404", async () => {
    const t = setup();
    await denied(reply(t, { reviewId: String(new ObjectId()) }), NotFoundError);
    const hidden = setup({
      review: reviewDoc({ status: "hidden" }),
      listingExtra: { reviews: [] },
    });
    await denied(reply(hidden), NotFoundError);
  });

  test("hidden between the page and the click: 404", async () => {
    const t = setup();
    t.reviews[0].status = "hidden"; // still in listing.reviews in this snapshot
    await denied(reply(t), NotFoundError);
    expect(t.reviews[0].reply).toBeUndefined();
  });

  test("blank, non-text or over-long: 400 before anything is looked up", async () => {
    const t = setup();
    for (const text of [undefined, "", "   ", "x".repeat(REPLY_MAX + 1)]) {
      await denied(reply(t, { text }), ValidationError);
    }
    expect(t.ReviewModel.findOne).not.toHaveBeenCalled();
  });
});

describe("removeReply", () => {
  test("the host takes the reply back; doing it twice says there was none", async () => {
    const t = setup({
      review: reviewDoc({
        reply: { text: "Thanks", author: HOST._id, createdAt: NOW },
      }),
    });
    const args = {
      user: HOST,
      listing: t.listing,
      reviewId: String(t.review._id),
    };
    expect(await t.service.removeReply(args)).toBe(true);
    expect(t.reviews[0].reply).toBeUndefined();
    expect(await t.service.removeReply(args)).toBe(false);
  });

  test("only the host", async () => {
    const t = setup({
      review: reviewDoc({ reply: { text: "Thanks", createdAt: NOW } }),
    });
    await denied(
      t.service.removeReply({
        user: GUEST,
        listing: t.listing,
        reviewId: String(t.review._id),
      }),
      ForbiddenError,
      "not_host",
    );
    expect(t.reviews[0].reply.text).toBe("Thanks");
  });
});

describe("stateFor tells the booking page whether the review can still be edited", () => {
  const reservation = {
    _id: new ObjectId(),
    guest: GUEST._id,
    host: HOST._id,
    listing: LISTING_ID,
    status: "completed",
    checkOut: new Date("2026-11-10T00:00:00Z"),
    listingSnapshot: { timezone: "Asia/Kolkata" },
  };
  const state = (t, over = {}) =>
    t.service.stateFor({ user: GUEST, reservation, now: NOW, ...over });
  const withReview = (extra) => {
    const t = setup({
      review: reviewDoc({ reservation: reservation._id, ...extra }),
    });
    t.ReviewModel.findOne.mockImplementation(() => ({
      lean: async () => clone(t.reviews[0]),
    }));
    return t;
  };

  test("inside the window: editable, with the last moment", async () => {
    const out = await state(withReview());
    expect(out).toMatchObject({ state: "done", editable: true });
    expect(out.editUntil).toEqual(new Date(NOW.getTime() + 5 * DAY));
  });
  test("past the window or hidden: not editable", async () => {
    const old = await state(
      withReview({ createdAt: new Date(NOW.getTime() - 9 * DAY) }),
    );
    expect(old.editable).toBe(false);
    const hidden = await state(withReview({ status: "hidden" }));
    expect(hidden.editable).toBe(false);
  });
  test("the window follows editDays", async () => {
    const out = await state(
      withReview({ createdAt: new Date(NOW.getTime() - 9 * DAY) }),
      { editDays: 14 },
    );
    expect(out.editable).toBe(true);
  });
});
