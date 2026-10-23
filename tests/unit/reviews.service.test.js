// P12-T01: who may review a stay, and when. In-memory fakes, no database.
const { ObjectId } = require("mongoose").Types;
const {
  createReviewService,
  parseRating,
  parseComment,
  windowEnd,
  DEFAULT_WINDOW_DAYS,
} = require("../../src/services/reviews");
const {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../../src/utils/errors");
const { parseDateOnly, formatDateOnly } = require("../../src/utils/dates");

const d = (s) => parseDateOnly(s);
const GUEST = { _id: new ObjectId(), status: "active", role: "member" };
const HOST = { _id: new ObjectId(), status: "active", role: "member" };
const OTHER = { _id: new ObjectId(), status: "active", role: "member" };
const LISTING_ID = new ObjectId();
// 20 Nov 2026, 12:00 in Kolkata. The stay ended 10 Nov, so the window (30 days) closes 10 Dec.
const NOW = new Date("2026-11-20T06:30:00Z");

function stay(extra = {}) {
  return {
    _id: new ObjectId(),
    guest: GUEST._id,
    host: HOST._id,
    listing: LISTING_ID,
    checkIn: d("2026-11-07"),
    checkOut: d("2026-11-10"),
    status: "completed",
    listingSnapshot: {
      title: "Sea house",
      city: "Goa",
      timezone: "Asia/Kolkata",
    },
    ...extra,
  };
}

function setup(reservations = [stay()], options = {}) {
  const reviews = [];
  const pushes = [];
  const ReservationModel = {
    docs: reservations,
    findById: jest.fn(
      async (id) =>
        reservations.find((r) => String(r._id) === String(id)) || null,
    ),
    find: jest.fn((filter) => {
      let rows = reservations.filter(
        (r) =>
          String(r.guest) === String(filter.guest) &&
          String(r.listing) === String(filter.listing) &&
          r.status === filter.status,
      );
      const q = {
        sort: () => (
          (rows = [...rows].sort((a, b) => b.checkOut - a.checkOut)),
          q
        ),
        limit: (n) => ((rows = rows.slice(0, n)), q),
        lean: async () => rows,
      };
      return q;
    }),
  };
  const ReviewModel = {
    docs: reviews,
    exists: jest.fn(async (filter) =>
      reviews.some((r) => String(r.reservation) === String(filter.reservation))
        ? { _id: 1 }
        : null,
    ),
    create: jest.fn(async (doc) => {
      await Promise.resolve(); // a real insert yields; two inserts can interleave
      if (
        reviews.some((r) => String(r.reservation) === String(doc.reservation))
      ) {
        const err = new Error("E11000 duplicate key");
        err.code = 11000;
        throw err;
      }
      const stored = { _id: new ObjectId(), ...doc, createdAt: NOW };
      reviews.push(stored);
      return stored;
    }),
    find: jest.fn((filter) => {
      const ids = new Set(filter.reservation.$in.map(String));
      const rows = reviews.filter((r) => ids.has(String(r.reservation)));
      const q = { select: () => q, lean: async () => rows };
      return q;
    }),
  };
  const ListingModel = {
    updateOne: jest.fn(async (...args) => pushes.push(args)),
  };
  const service = createReviewService({
    ReservationModel,
    ReviewModel,
    ListingModel,
    ...options,
  });
  const submit = (over = {}) =>
    service.submit({
      user: GUEST,
      listingId: String(LISTING_ID),
      reservationId: String(reservations[0]._id),
      rating: "5",
      comment: "Lovely stay.",
      now: NOW,
      ...over,
    });
  return {
    service,
    submit,
    reviews,
    pushes,
    ReservationModel,
    ReviewModel,
    ListingModel,
    reservations,
  };
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

describe("parseRating / parseComment", () => {
  test.each([
    ["1", 1],
    ["5", 5],
    [" 3 ", 3],
    [4, 4],
  ])("rating %j", (raw, n) => expect(parseRating(raw)).toBe(n));
  test.each([
    [undefined],
    [null],
    [""],
    ["0"],
    ["6"],
    ["4.5"],
    ["five"],
    [2.5],
    [0],
    [[5]],
    [{}],
    ["5; drop"],
  ])("a bad rating %j", (raw) => {
    expect(() => parseRating(raw)).toThrow(ValidationError);
  });
  test("comments are trimmed, 1 to 2000 characters", () => {
    expect(parseComment("  Nice  ")).toBe("Nice");
    expect(parseComment("x".repeat(2000))).toHaveLength(2000);
    for (const bad of [undefined, null, "", "   ", 5, ["a"], "x".repeat(2001)])
      expect(() => parseComment(bad)).toThrow(ValidationError);
  });
});

describe("a completed stay can be reviewed", () => {
  test("stored with the reservation, the listing, a snapshot and legacy false; pushed to the listing", async () => {
    const t = setup();
    const review = await t.submit({ comment: "  Lovely stay.  " });
    expect(t.reviews).toHaveLength(1);
    expect(review).toMatchObject({
      author: GUEST._id,
      listing: LISTING_ID,
      reservation: t.reservations[0]._id,
      rating: 5,
      comment: "Lovely stay.",
      legacy: false,
      listingSnapshot: { title: "Sea house", city: "Goa" },
    });
    expect(t.pushes).toEqual([
      [{ _id: LISTING_ID }, { $push: { reviews: review._id } }],
    ]);
  });
});

describe("every eligibility denial", () => {
  test.each([
    ["pending", "pending"],
    ["confirmed", "confirmed"],
    ["declined", "declined"],
    ["expired", "expired"],
    ["cancelled by guest", "cancelled_by_guest"],
    ["cancelled by host", "cancelled_by_host"],
  ])("a %s stay: 409 stay_not_completed", async (_n, status) => {
    const t = setup([stay({ status })]);
    await denied(t.submit(), ConflictError, "stay_not_completed");
    expect(t.reviews).toHaveLength(0);
  });

  test("another member's stay, a missing stay and a malformed id are the same 404", async () => {
    const t = setup();
    const a = await denied(t.submit({ user: OTHER }), NotFoundError);
    const b = await denied(
      t.submit({ reservationId: String(new ObjectId()) }),
      NotFoundError,
    );
    const c = await denied(t.submit({ reservationId: "nope" }), NotFoundError);
    const e = await denied(
      t.submit({ reservationId: undefined }),
      NotFoundError,
    );
    expect([a.message, b.message, c.message, e.message]).toEqual(
      Array(4).fill("That stay does not exist."),
    );
    expect(t.reviews).toHaveLength(0);
  });

  test("a stay of a different listing than the URL's: 404", async () => {
    const t = setup();
    await denied(
      t.submit({ listingId: String(new ObjectId()) }),
      NotFoundError,
    );
  });

  test("the host of the place cannot review it: 403 own_listing", async () => {
    const t = setup([stay({ guest: HOST._id })]);
    await denied(t.submit({ user: HOST }), ForbiddenError, "own_listing");
    expect(t.reviews).toHaveLength(0);
  });

  test.each([
    ["suspended", { ...GUEST, status: "suspended" }],
    ["signed out", undefined],
  ])("a %s author: 403 account_not_active", async (_n, user) => {
    const t = setup();
    await denied(t.submit({ user }), ForbiddenError, "account_not_active");
    expect(t.ReservationModel.findById).not.toHaveBeenCalled();
  });

  test("bad input is refused before anything is looked up", async () => {
    const t = setup();
    await denied(t.submit({ rating: "9" }), ValidationError);
    await denied(t.submit({ comment: "" }), ValidationError);
    expect(t.ReservationModel.findById).not.toHaveBeenCalled();
  });
});

describe("the review window", () => {
  const at = (iso) => new Date(iso);
  test("windowEnd is check-out plus the window, as a date", () => {
    expect(formatDateOnly(windowEnd(stay(), 30))).toBe("2026-12-10");
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
  });
  test("the last day is allowed, the next day is not", async () => {
    const t = setup();
    // 10 Dec 2026, 23:30 in Kolkata is still the 10th.
    const review = await t.submit({ now: at("2026-12-10T18:00:00Z") });
    expect(review.rating).toBe(5);
    const closed = setup();
    const err = await denied(
      closed.submit({ now: at("2026-12-10T18:31:00Z") }),
      ConflictError,
      "review_window_closed",
    ); // 00:01 on the 11th
    expect(err.message).toMatch(/30 days after check-out/);
    expect(closed.reviews).toHaveLength(0);
  });
  test("the window is configurable, per service and per call", async () => {
    const short = setup([stay()], { windowDays: 7 });
    await denied(
      short.submit({ now: at("2026-11-18T06:00:00Z") }),
      ConflictError,
      "review_window_closed",
    );
    const ok = setup([stay()], { windowDays: 7 });
    expect((await ok.submit({ now: at("2026-11-17T06:00:00Z") })).rating).toBe(
      5,
    );
    const perCall = setup();
    await denied(
      perCall.submit({ windowDays: 5, now: at("2026-11-20T06:00:00Z") }),
      ConflictError,
      "review_window_closed",
    );
  });
  test("the window follows the stay's own time zone, not the server's", async () => {
    const t = setup([
      stay({ listingSnapshot: { title: "x", timezone: "America/New_York" } }),
    ]);
    // 11 Dec 2026, 03:00 UTC is still 10 Dec in New York.
    expect((await t.submit({ now: at("2026-12-11T03:00:00Z") })).rating).toBe(
      5,
    );
  });
});

describe("one review per stay", () => {
  test("a second attempt is a 409 already_reviewed", async () => {
    const t = setup();
    await t.submit();
    await denied(
      t.submit({ comment: "Again" }),
      ConflictError,
      "already_reviewed",
    );
    expect(t.reviews).toHaveLength(1);
    expect(t.pushes).toHaveLength(1);
  });

  test("ten requests at once: exactly one review, the rest 409, one push to the listing", async () => {
    const t = setup();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => t.submit()),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(r.reason).toBeInstanceOf(ConflictError);
      expect(r.reason.code).toBe("already_reviewed");
    }
    expect(t.reviews).toHaveLength(1);
    expect(t.pushes).toHaveLength(1);
  });

  test("a second stay at the same place can be reviewed separately", async () => {
    const first = stay();
    const second = stay({
      checkOut: d("2026-11-15"),
      checkIn: d("2026-11-12"),
    });
    const t = setup([first, second]);
    await t.submit({ reservationId: String(first._id) });
    await t.submit({
      reservationId: String(second._id),
      comment: "Second time",
    });
    expect(t.reviews).toHaveLength(2);
  });

  test("a failure that is not a duplicate is not hidden", async () => {
    const t = setup();
    t.ReviewModel.create.mockRejectedValueOnce(new Error("disk full"));
    await expect(t.submit()).rejects.toThrow("disk full");
  });
});

describe("the listing was deleted after the stay", () => {
  test("the stay can still be reviewed; the review keeps the listing id and the snapshot", async () => {
    const t = setup();
    t.ListingModel.updateOne.mockResolvedValue({ matchedCount: 0 }); // nothing to push to, no error
    const review = await t.submit();
    expect(String(review.listing)).toBe(String(LISTING_ID));
    expect(review.listingSnapshot.title).toBe("Sea house");
  });
});

describe("findReviewable (does the page offer the form?)", () => {
  const find = (t, over = {}) =>
    t.service.findReviewable({
      user: GUEST,
      listingId: String(LISTING_ID),
      now: NOW,
      ...over,
    });
  test("a completed, unreviewed stay inside the window", async () => {
    const t = setup();
    const found = await find(t);
    expect(found.reservationId).toBe(String(t.reservations[0]._id));
    expect(formatDateOnly(found.reviewUntil)).toBe("2026-12-10");
  });
  test("nothing when reviewed, late, not completed, for another listing, or for a stranger", async () => {
    const t = setup();
    await t.submit();
    expect(await find(t)).toBeNull();
    expect(
      await find(setup(), { now: new Date("2027-01-01T00:00:00Z") }),
    ).toBeNull();
    expect(await find(setup([stay({ status: "confirmed" })]))).toBeNull();
    expect(
      await find(setup(), { listingId: String(new ObjectId()) }),
    ).toBeNull();
    expect(await find(setup(), { user: OTHER })).toBeNull();
    expect(await find(setup(), { user: undefined })).toBeNull();
    expect(
      await find(setup(), { user: { ...GUEST, status: "suspended" } }),
    ).toBeNull();
    expect(await find(setup(), { listingId: "x" })).toBeNull();
  });
  test("with several stays it offers the newest that is still open", async () => {
    const older = stay({ checkOut: d("2026-11-01"), checkIn: d("2026-10-29") });
    const newer = stay({ checkOut: d("2026-11-15"), checkIn: d("2026-11-12") });
    const t = setup([older, newer]);
    expect((await find(t)).reservationId).toBe(String(newer._id));
    await t.submit({ reservationId: String(newer._id) });
    expect((await find(t)).reservationId).toBe(String(older._id));
  });
  test("a host is never offered their own place", async () => {
    expect(
      await find(setup([stay({ guest: HOST._id })]), { user: HOST }),
    ).toBeNull();
  });
});
