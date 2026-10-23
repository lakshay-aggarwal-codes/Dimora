// Writing a review (P12-T01): who may review, and when.
//
// A review belongs to one completed reservation (ADR-010). Every rule has its
// own message and code:
//   not found / not yours ........ 404  (the same answer for both)
//   suspended or signed-out ...... 403 account_not_active
//   own listing .................. 403 own_listing
//   stay not completed ........... 409 stay_not_completed
//   past the window .............. 409 review_window_closed (default 30 days after check-out)
//   already reviewed ............. 409 already_reviewed (also when two requests race: the
//                                  partial unique index on `reservation` decides)
//   bad rating or comment ........ 400
// A review is still allowed after the host deleted the listing: it stays
// attached to the listing's id and to the snapshot taken at booking time.
const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require("../utils/errors");
const {
  DEFAULT_TIMEZONE,
  todayIn,
  addDays,
  isAfter,
} = require("../utils/dates");
const { isActiveUser, sameId } = require("../policies/shared");

const DEFAULT_WINDOW_DAYS = 30;
const COMMENT_MAX = 2000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** The last day (date-only) a stay can be reviewed: check-out + window. */
function windowEnd(reservation, windowDays) {
  return addDays(reservation.checkOut, windowDays);
}

function parseRating(raw) {
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !/^[1-5]$/.test(text.trim())) {
    throw new ValidationError("Choose a rating from 1 to 5 stars.");
  }
  return Number(text.trim());
}

function parseComment(raw) {
  if (typeof raw !== "string")
    throw new ValidationError("Write a comment about your stay.");
  const text = raw.trim();
  if (text.length === 0)
    throw new ValidationError("Write a comment about your stay.");
  if (text.length > COMMENT_MAX) {
    throw new ValidationError(
      `The comment can be at most ${COMMENT_MAX} characters.`,
    );
  }
  return text;
}

const isDuplicateKey = (err) =>
  Boolean(err) && (err.code === 11000 || err.code === 11001);

function createReviewService({
  ReservationModel = require("../models/reservation"),
  ReviewModel = require("../models/review"),
  ListingModel = require("../models/listing"),
  windowDays = DEFAULT_WINDOW_DAYS,
} = {}) {
  /**
   * @param {{ user: object, listingId: string, reservationId: string,
   *           rating: unknown, comment: unknown, now?: Date, windowDays?: number }} input
   * @returns {Promise<object>} the stored review
   */
  async function submit({
    user,
    listingId,
    reservationId,
    rating,
    comment,
    now = new Date(),
    windowDays: days = windowDays,
  }) {
    // Input first: nothing is looked up for a request that is wrong in itself.
    const stars = parseRating(rating);
    const text = parseComment(comment);

    if (!isActiveUser(user)) {
      throw new ForbiddenError("Your account cannot write reviews.", {
        code: "account_not_active",
      });
    }
    const reservation = OBJECT_ID.test(String(reservationId))
      ? await ReservationModel.findById(reservationId)
      : null;
    // Somebody else's booking, a booking of another listing, and a booking that
    // does not exist all look the same.
    if (
      !reservation ||
      !sameId(reservation.guest, user._id) ||
      (listingId && !sameId(reservation.listing, listingId))
    ) {
      throw new NotFoundError("That stay does not exist.");
    }
    if (sameId(reservation.host, user._id)) {
      throw new ForbiddenError("You cannot review your own listing.", {
        code: "own_listing",
      });
    }
    if (reservation.status !== "completed") {
      throw new ConflictError("You can review a stay once it is completed.", {
        code: "stay_not_completed",
      });
    }
    const snapshot = reservation.listingSnapshot || {};
    const today = todayIn(snapshot.timezone || DEFAULT_TIMEZONE, now);
    if (isAfter(today, windowEnd(reservation, days))) {
      throw new ConflictError(
        `Reviews can be written up to ${days} days after check-out.`,
        {
          code: "review_window_closed",
        },
      );
    }
    if (await ReviewModel.exists({ reservation: reservation._id })) {
      throw new ConflictError("You have already reviewed this stay.", {
        code: "already_reviewed",
      });
    }

    let review;
    try {
      review = await ReviewModel.create({
        author: user._id,
        listing: reservation.listing,
        reservation: reservation._id,
        rating: stars,
        comment: text,
        legacy: false,
        listingSnapshot: { title: snapshot.title, city: snapshot.city },
      });
    } catch (err) {
      // Two requests for the same stay at once: the unique index let one in.
      if (isDuplicateKey(err)) {
        throw new ConflictError("You have already reviewed this stay.", {
          code: "already_reviewed",
        });
      }
      throw err;
    }
    // The listing page still reads listing.reviews; P12-T02 moves it to a query.
    await ListingModel.updateOne(
      { _id: reservation.listing },
      { $push: { reviews: review._id } },
    );
    return review;
  }

  /**
   * The stay a signed-in guest could review on this listing right now, or
   * null: completed, inside the window, not reviewed yet, newest check-out first.
   * It only decides whether the page offers the form; `submit` decides again.
   */
  async function findReviewable({
    user,
    listingId,
    now = new Date(),
    windowDays: days = windowDays,
  }) {
    if (!isActiveUser(user) || !OBJECT_ID.test(String(listingId))) return null;
    const candidates = await ReservationModel.find({
      guest: user._id,
      listing: listingId,
      status: "completed",
    })
      .sort({ checkOut: -1 })
      .limit(10)
      .lean();
    const open = candidates.filter((r) => {
      const snap = r.listingSnapshot || {};
      return (
        !isAfter(
          todayIn(snap.timezone || DEFAULT_TIMEZONE, now),
          windowEnd(r, days),
        ) && !sameId(r.host, user._id)
      );
    });
    if (open.length === 0) return null;
    const reviewed = await ReviewModel.find({
      reservation: { $in: open.map((r) => r._id) },
    })
      .select("reservation")
      .lean();
    const done = new Set(reviewed.map((r) => String(r.reservation)));
    const next = open.find((r) => !done.has(String(r._id)));
    return next
      ? { reservationId: String(next._id), reviewUntil: windowEnd(next, days) }
      : null;
  }

  return { submit, findReviewable };
}

module.exports = {
  ...createReviewService(),
  createReviewService,
  parseRating,
  parseComment,
  windowEnd,
  DEFAULT_WINDOW_DAYS,
  COMMENT_MAX,
};
