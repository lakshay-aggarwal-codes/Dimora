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
// Editing and replying (P12-T03):
//   edit: only the author, only while the review is visible and inside the edit
//   window (REVIEW_EDIT_DAYS after it was posted); 409 review_edit_window_closed
//   after that. A new rating moves the listing's totals by the difference, in
//   one atomic update (ratings.changeRating).
//   reply: only the listing's host, one reply per review (writing again
//   replaces it), never on a hidden review, 1000 characters at most.
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
const ratings = require("./ratings");

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_EDIT_DAYS = 7;
const COMMENT_MAX = 2000;
const REPLY_MAX = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
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

function parseReply(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) throw new ValidationError("Write a reply.");
  if (text.length > REPLY_MAX) {
    throw new ValidationError(
      `The reply can be at most ${REPLY_MAX} characters.`,
    );
  }
  return text;
}

/** When a review was posted: `createdAt`, else the time its id was created. */
function postedAt(review) {
  const created =
    review && review.createdAt ? new Date(review.createdAt) : null;
  if (created && !Number.isNaN(created.getTime())) return created;
  return review && review._id && typeof review._id.getTimestamp === "function"
    ? review._id.getTimestamp()
    : null;
}

/** The moment the author can no longer edit this review (null if its age is unknown). */
function editDeadline(review, editDays = DEFAULT_EDIT_DAYS) {
  const posted = postedAt(review);
  return posted ? new Date(posted.getTime() + editDays * DAY_MS) : null;
}

/** Can the author still edit? (Ownership and status are checked elsewhere.) */
function isEditable(review, now = new Date(), editDays = DEFAULT_EDIT_DAYS) {
  if (!review || review.status === "hidden") return false;
  const deadline = editDeadline(review, editDays);
  return Boolean(deadline) && now.getTime() <= deadline.getTime();
}

const isDuplicateKey = (err) =>
  Boolean(err) && (err.code === 11000 || err.code === 11001);

function createReviewService({
  ReservationModel = require("../models/reservation"),
  ReviewModel = require("../models/review"),
  ListingModel = require("../models/listing"),
  windowDays = DEFAULT_WINDOW_DAYS,
  editDays = DEFAULT_EDIT_DAYS,
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
    // One atomic update adds the review to the listing's list and to its rating
    // totals (services/ratings.js). If it fails, the review is taken back so a
    // review never exists without being counted.
    try {
      await ratings.addReview(ListingModel, reservation.listing, review);
    } catch (err) {
      await ReviewModel.deleteOne({ _id: review._id }).catch(() => {});
      throw err;
    }
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

  /**
   * Delete a review and take it out of the listing's list and totals. Only the
   * request that really deleted it changes the totals, so deleting twice at
   * once subtracts once. Who may delete is the route's `review:delete` policy.
   * @returns {Promise<object|null>} the deleted review, or null if it was already gone
   */
  async function remove({ listingId, reviewId }) {
    const removed = await ReviewModel.findOneAndDelete({ _id: reviewId });
    if (!removed) return null;
    // A hidden review (P14-T04) was already taken out of the list and the
    // totals when it was hidden; subtracting again would count it twice.
    if (removed.status === "hidden") return removed;
    try {
      await ratings.removeReview(ListingModel, listingId, removed);
    } catch (err) {
      // The review is gone but the totals were not changed: repair them from the reviews.
      await ratings
        .recomputeRatings({ ListingModel, ReviewModel }, listingId)
        .catch(() => {});
      throw err;
    }
    return removed;
  }

  /**
   * What the booking page shows about reviewing a stay:
   *   "open"   completed, inside the window, not reviewed (the form)
   *   "done"   already reviewed (the review)
   *   "closed" completed, not reviewed, the window has passed
   *   "none"   anything else (not the guest, not completed yet)
   * @returns {Promise<{state: string, review?: object, until?: Date}>}
   */
  async function stateFor({
    user,
    reservation,
    now = new Date(),
    windowDays: days = windowDays,
    editDays: editFor = editDays,
  }) {
    if (
      !isActiveUser(user) ||
      !reservation ||
      !sameId(reservation.guest, user._id) ||
      reservation.status !== "completed"
    ) {
      return { state: "none" };
    }
    const review = await ReviewModel.findOne({
      reservation: reservation._id,
    }).lean();
    if (review) {
      return {
        state: "done",
        review,
        editable: isEditable(review, now, editFor),
        editUntil: editDeadline(review, editFor),
      };
    }
    const snap = reservation.listingSnapshot || {};
    const until = windowEnd(reservation, days);
    const open = !isAfter(
      todayIn(snap.timezone || DEFAULT_TIMEZONE, now),
      until,
    );
    return { state: open ? "open" : "closed", until };
  }

  /**
   * The author changes the rating and/or comment of their own review, inside
   * the edit window. One compare-and-set on the review (author, visible, still
   * inside the window) returns the document as it was, so the rating difference
   * is exact even when two edits arrive together; then ONE atomic update moves
   * the listing's totals by that difference. If that update fails the review is
   * put back, so the review and the totals never disagree.
   * @returns {Promise<{review: object, changed: boolean}>}
   */
  async function edit({
    user,
    listingId,
    reviewId,
    rating,
    comment,
    now = new Date(),
    editDays: days = editDays,
  }) {
    const stars = parseRating(rating);
    const text = parseComment(comment);
    if (!isActiveUser(user)) {
      throw new ForbiddenError("Your account cannot edit reviews.", {
        code: "account_not_active",
      });
    }
    if (!OBJECT_ID.test(String(reviewId))) {
      throw new NotFoundError("That review does not exist.");
    }
    const current = await ReviewModel.findOne({ _id: reviewId });
    // Somebody else's review, a review of another listing, a hidden review and
    // one that does not exist all look the same.
    if (
      !current ||
      current.status === "hidden" ||
      !sameId(current.author, user._id) ||
      (current.listing && listingId && !sameId(current.listing, listingId))
    ) {
      throw new NotFoundError("That review does not exist.");
    }
    if (!isEditable(current, now, days)) {
      throw new ConflictError(
        `A review can be edited for ${days} days after it was posted.`,
        { code: "review_edit_window_closed" },
      );
    }
    if (current.rating === stars && current.comment === text) {
      return { review: current, changed: false };
    }

    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const before = await ReviewModel.findOneAndUpdate(
      {
        _id: current._id,
        author: user._id,
        status: { $ne: "hidden" },
        createdAt: { $gte: cutoff },
      },
      { $set: { rating: stars, comment: text, editedAt: now } },
      { new: false },
    );
    if (!before) {
      // Hidden, deleted or past the window between the read and the write.
      throw new ConflictError("This review can no longer be edited.", {
        code: "review_edit_window_closed",
      });
    }

    if (before.rating !== stars) {
      const target = before.listing || current.listing || listingId;
      try {
        await ratings.changeRating(ListingModel, target, {
          from: before.rating,
          to: stars,
        });
        // Hidden while we were changing it: the totals no longer include it,
        // so repair them from the reviews instead of trusting the difference.
        if (await ReviewModel.exists({ _id: before._id, status: "hidden" })) {
          await ratings.recomputeRatings({ ListingModel, ReviewModel }, target);
        }
      } catch (err) {
        await ReviewModel.updateOne(
          { _id: before._id },
          {
            $set: {
              rating: before.rating,
              comment: before.comment,
              ...(before.editedAt ? { editedAt: before.editedAt } : {}),
            },
            ...(before.editedAt ? {} : { $unset: { editedAt: "" } }),
          },
        ).catch(() => {});
        throw err;
      }
    }
    const plain = before.toObject ? before.toObject() : { ...before };
    return {
      review: { ...plain, rating: stars, comment: text, editedAt: now },
      changed: true,
    };
  }

  // The listing's host (who `listing` is, already authorized by the route's
  // `review:reply` policy) answers a visible review of that listing.
  async function loadReplyTarget({ user, listing, reviewId }) {
    if (!isActiveUser(user) || !listing || !sameId(listing.owner, user._id)) {
      throw new ForbiddenError("Only the host can reply to reviews.", {
        code: "not_host",
      });
    }
    // A hidden review leaves the listing's list, so membership covers it too.
    const listed = (listing.reviews || []).some((r) => sameId(r, reviewId));
    if (!listed || !OBJECT_ID.test(String(reviewId))) {
      throw new NotFoundError("That review does not exist.");
    }
  }

  /**
   * The host writes (or replaces) the one public reply to a review. Replacing
   * keeps the first reply's date and records `editedAt`.
   * @returns {Promise<object>} the review with its reply
   */
  async function reply({ user, listing, reviewId, text, now = new Date() }) {
    const body = parseReply(text);
    await loadReplyTarget({ user, listing, reviewId });
    const existing = await ReviewModel.findOne({
      _id: reviewId,
      status: { $ne: "hidden" },
    });
    if (!existing) throw new NotFoundError("That review does not exist.");
    const had = existing.reply && existing.reply.text;
    const update = had
      ? { $set: { "reply.text": body, "reply.editedAt": now } }
      : {
          $set: {
            reply: {
              text: body,
              author: user._id,
              createdAt: now,
            },
          },
        };
    const saved = await ReviewModel.findOneAndUpdate(
      { _id: reviewId, status: { $ne: "hidden" } },
      update,
      { new: true },
    );
    if (!saved) throw new NotFoundError("That review does not exist.");
    return saved;
  }

  /** The host takes their reply back. @returns {Promise<boolean>} whether there was one */
  async function removeReply({ user, listing, reviewId }) {
    await loadReplyTarget({ user, listing, reviewId });
    const done = await ReviewModel.findOneAndUpdate(
      { _id: reviewId, "reply.text": { $exists: true } },
      { $unset: { reply: "" } },
      { new: false },
    );
    return Boolean(done);
  }

  return {
    submit,
    remove,
    edit,
    reply,
    removeReply,
    findReviewable,
    stateFor,
  };
}

module.exports = {
  ...createReviewService(),
  createReviewService,
  parseRating,
  parseComment,
  parseReply,
  windowEnd,
  editDeadline,
  isEditable,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_EDIT_DAYS,
  COMMENT_MAX,
  REPLY_MAX,
};
