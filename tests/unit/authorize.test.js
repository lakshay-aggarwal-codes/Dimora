// P02-T06: the authorize() and requireRole() middleware with the models
// stubbed (no database, no app).
const { ObjectId } = require("mongoose").Types;
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const { authorize } = require("../../src/middleware/authorize");
const { requireRole } = require("../../src/middleware/auth");
const { ForbiddenError, NotFoundError } = require("../../src/utils/errors");

afterEach(() => jest.restoreAllMocks());

const me = new ObjectId();
const makeReq = (extra = {}) => ({
  params: { id: "L1" },
  user: { _id: me, role: "member", status: "active" },
  session: {},
  originalUrl: "/listings/L1/edit",
  flash: jest.fn(),
  ...extra,
});
const makeRes = () => ({ redirect: jest.fn() });

describe("authorize('listing:edit')", () => {
  const run = (req) => {
    const res = makeRes();
    const next = jest.fn();
    return authorize("listing:edit")(req, res, next).then(() => ({
      res,
      next,
    }));
  };

  test("anonymous goes to the login page, and the database is not asked", async () => {
    const find = jest.spyOn(Listing, "findById");
    const req = makeReq({ user: undefined });
    const { res, next } = await run(req);
    expect(res.redirect).toHaveBeenCalledWith("/login");
    expect(req.session.redirectUrl).toBe("/listings/L1/edit");
    expect(next).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  test("a missing listing is a 404", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue(null);
    await expect(run(makeReq())).rejects.toBeInstanceOf(NotFoundError);
  });

  test("someone else's listing is a 403 with a plain message", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ owner: new ObjectId() });
    const error = await run(makeReq()).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.statusCode).toBe(403);
    expect(error.message).toMatch(/host/);
  });

  test("a listing without an owner is a 403, not a crash", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ owner: undefined });
    await expect(run(makeReq())).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the owner passes and the listing is left on req.listing", async () => {
    const listing = { owner: me };
    jest.spyOn(Listing, "findById").mockResolvedValue(listing);
    const req = makeReq();
    const { next } = await run(req);
    expect(next).toHaveBeenCalledWith();
    expect(req.listing).toBe(listing);
  });

  test("a suspended owner is a 403", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ owner: me });
    const req = makeReq({ user: { _id: me, role: "member", status: "suspended" } });
    await expect(run(req)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("concealForbidden turns the 403 into a 404", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ owner: new ObjectId() });
    const mw = authorize("listing:edit", { concealForbidden: true });
    await expect(mw(makeReq(), makeRes(), jest.fn())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("authorize('listing:delete')", () => {
  test("an admin may delete someone else's listing", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ owner: new ObjectId() });
    const req = makeReq({ user: { _id: new ObjectId(), role: "admin" } });
    const next = jest.fn();
    await authorize("listing:delete")(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe("authorize('listing:create') / ('review:create')", () => {
  test("no resource is loaded; an active member passes", async () => {
    const find = jest.spyOn(Listing, "findById");
    const next = jest.fn();
    await authorize("listing:create")(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(find).not.toHaveBeenCalled();
  });

  test("a suspended member is a 403", async () => {
    const req = makeReq({ user: { _id: me, status: "suspended" } });
    await expect(
      authorize("review:create")(req, makeRes(), jest.fn()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("authorize('review:delete')", () => {
  const reviewId = new ObjectId();
  const req = (extra) =>
    makeReq({ params: { id: "L1", reviewId: String(reviewId) }, ...extra });

  test("the author passes and the review is left on req.review", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ reviews: [reviewId] });
    const found = { author: me };
    jest.spyOn(Review, "findById").mockResolvedValue(found);
    const rq = req();
    const next = jest.fn();
    await authorize("review:delete")(rq, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(rq.review).toBe(found);
  });

  test("another member gets a 403", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ reviews: [reviewId] });
    jest.spyOn(Review, "findById").mockResolvedValue({ author: new ObjectId() });
    await expect(
      authorize("review:delete")(req(), makeRes(), jest.fn()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a review that is not on this listing is a 404 (even for its author)", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ reviews: [] });
    const reviewLookup = jest
      .spyOn(Review, "findById")
      .mockResolvedValue({ author: me });
    await expect(
      authorize("review:delete")(req(), makeRes(), jest.fn()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(reviewLookup).not.toHaveBeenCalled();
  });

  test("a missing listing is a 404", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue(null);
    await expect(
      authorize("review:delete")(req(), makeRes(), jest.fn()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("authorize('review:reply', { resource: 'listing' })", () => {
  const reviewId = new ObjectId();
  const req = (extra) =>
    makeReq({ params: { id: "L1", reviewId: String(reviewId) }, ...extra });
  const run = (rq) => {
    const next = jest.fn();
    return authorize("review:reply", { resource: "listing" })(
      rq,
      makeRes(),
      next,
    ).then(() => next);
  };

  test("the host passes and the LISTING is left on req.listing; no review is loaded", async () => {
    const found = { owner: me, reviews: [reviewId] };
    jest.spyOn(Listing, "findById").mockResolvedValue(found);
    const reviewLookup = jest.spyOn(Review, "findById");
    const rq = req();
    const next = await run(rq);
    expect(next).toHaveBeenCalledWith();
    expect(rq.listing).toBe(found);
    expect(reviewLookup).not.toHaveBeenCalled();
  });

  test("another member gets a 403 with the reply message", async () => {
    jest
      .spyOn(Listing, "findById")
      .mockResolvedValue({ owner: new ObjectId(), reviews: [reviewId] });
    await expect(run(req())).rejects.toMatchObject({
      statusCode: 403,
      message: "Only the host can reply to reviews.",
    });
  });

  test("a missing listing is a 404", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue(null);
    await expect(run(req())).rejects.toBeInstanceOf(NotFoundError);
  });

  test("anonymous goes to the login page", async () => {
    const find = jest.spyOn(Listing, "findById");
    const res = makeRes();
    await authorize("review:reply", { resource: "listing" })(
      req({ user: undefined }),
      res,
      jest.fn(),
    );
    expect(res.redirect).toHaveBeenCalledWith("/login");
    expect(find).not.toHaveBeenCalled();
  });
});

describe("authorize('review:edit')", () => {
  const reviewId = new ObjectId();
  const req = (extra) =>
    makeReq({ params: { id: "L1", reviewId: String(reviewId) }, ...extra });

  test("the author passes; another member and an admin get a 403", async () => {
    jest.spyOn(Listing, "findById").mockResolvedValue({ reviews: [reviewId] });
    const found = { author: me };
    jest.spyOn(Review, "findById").mockResolvedValue(found);
    const rq = req();
    const next = jest.fn();
    await authorize("review:edit")(rq, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(rq.review).toBe(found);

    Review.findById.mockResolvedValue({ author: new ObjectId() });
    await expect(
      authorize("review:edit")(req(), makeRes(), jest.fn()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      authorize("review:edit")(
        req({ user: { _id: new ObjectId(), role: "admin", status: "active" } }),
        makeRes(),
        jest.fn(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

test("authorize() rejects an unknown action when the route is defined", () => {
  expect(() => authorize("listing:fly")).toThrow(/Unknown policy action/);
});

describe("requireRole('admin')", () => {
  const guard = requireRole("admin");

  test("anonymous goes to the login page", () => {
    const res = makeRes();
    const next = jest.fn();
    guard(makeReq({ user: undefined }), res, next);
    expect(res.redirect).toHaveBeenCalledWith("/login");
    expect(next).not.toHaveBeenCalled();
  });

  test("a member is a 403", () => {
    expect(() => guard(makeReq(), makeRes(), jest.fn())).toThrow(ForbiddenError);
  });

  test("a suspended admin is a 403", () => {
    const req = makeReq({ user: { _id: me, role: "admin", status: "suspended" } });
    expect(() => guard(req, makeRes(), jest.fn())).toThrow(ForbiddenError);
  });

  test("an active admin passes", () => {
    const next = jest.fn();
    guard(makeReq({ user: { _id: me, role: "admin" } }), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  test("an unknown role is rejected when the guard is created", () => {
    expect(() => requireRole("owner")).toThrow(/unknown role/);
  });
});
