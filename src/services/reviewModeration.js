// Hiding and restoring a review (P14-T04). The routes (src/routes/admin.js)
// call these inside auditedMutation, which writes the audit row; nothing here
// writes one.
//
// Hide: a visible review becomes `hidden` with a compare-and-set, so two
// admins at once cannot both succeed; then, in ONE atomic update of the
// listing (services/ratings.js), the review leaves the listing's list and its
// rating totals. Restore does the same in reverse. If the listing update
// fails the review's status is put back, so the status and the totals never
// disagree. The guest's stay still counts as reviewed, so hiding does not let
// the guest write a new review for it.
const mongoose = require("mongoose");
const ratings = require("./ratings");

const REASON_MIN = 5;
const REASON_MAX = 500;

class ReviewModerationError extends Error {
  /** @param {string} message user-safe text, shown to the admin */
  constructor(message) {
    super(message);
    this.name = "ReviewModerationError";
  }
}

const isId = (value) =>
  typeof value === "string" && mongoose.isValidObjectId(value);

function cleanReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < REASON_MIN) {
    throw new ReviewModerationError(
      `Give a reason (at least ${REASON_MIN} characters). It is written to the audit log.`,
    );
  }
  if (reason.length > REASON_MAX) {
    throw new ReviewModerationError(
      `The reason must be ${REASON_MAX} characters or fewer.`,
    );
  }
  return reason;
}

function deps(over = {}) {
  return {
    ReviewModel: over.ReviewModel || require("../models/review"),
    ListingModel: over.ListingModel || require("../models/listing"),
  };
}

/** The listing a review belongs to: its own field, else the listing that holds it. */
async function listingIdOf(review, ListingModel) {
  if (review.listing) return review.listing;
  const holder = await ListingModel.findOne({ reviews: review._id })
    .select("_id")
    .lean();
  return holder ? holder._id : null;
}

async function hideReview({ admin, id, reason, now = new Date(), ...over }) {
  const { ReviewModel, ListingModel } = deps(over);
  const why = cleanReason(reason);
  if (!isId(id)) throw new ReviewModerationError("That review does not exist.");

  const review = await ReviewModel.findOneAndUpdate(
    { _id: id, status: { $ne: "hidden" } },
    {
      $set: {
        status: "hidden",
        "moderation.hiddenAt": now,
        "moderation.hiddenBy": admin._id,
        "moderation.hiddenReason": why,
      },
    },
    { new: true },
  ).lean();
  if (!review) {
    const exists = await ReviewModel.exists({ _id: id });
    throw new ReviewModerationError(
      exists ? "This review is already hidden." : "That review does not exist.",
    );
  }
  const listingId = await listingIdOf(review, ListingModel);
  try {
    if (listingId) await ratings.removeReview(ListingModel, listingId, review);
  } catch (err) {
    await ReviewModel.updateOne(
      { _id: id },
      { $set: { status: "visible" }, $unset: { moderation: "" } },
    );
    throw err;
  }
  return {
    review,
    listingId,
    reason: why,
    details: {
      rating: review.rating,
      listingId: listingId ? String(listingId) : null,
    },
  };
}

async function restoreReview({ admin, id, reason, ...over }) {
  const { ReviewModel, ListingModel } = deps(over);
  const why = cleanReason(reason);
  if (!isId(id)) throw new ReviewModerationError("That review does not exist.");

  const review = await ReviewModel.findOneAndUpdate(
    { _id: id, status: "hidden" },
    { $set: { status: "visible" }, $unset: { moderation: "" } },
    { new: true },
  ).lean();
  if (!review) {
    const exists = await ReviewModel.exists({ _id: id });
    throw new ReviewModerationError(
      exists ? "This review is not hidden." : "That review does not exist.",
    );
  }
  const listingId = await listingIdOf(review, ListingModel);
  try {
    if (listingId) await ratings.addReview(ListingModel, listingId, review);
  } catch (err) {
    await ReviewModel.updateOne(
      { _id: id },
      {
        $set: {
          status: "hidden",
          "moderation.hiddenAt": new Date(),
          "moderation.hiddenBy": admin._id,
          "moderation.hiddenReason": "(restore failed; hidden again)",
        },
      },
    );
    throw err;
  }
  return {
    review,
    listingId,
    reason: why,
    details: {
      rating: review.rating,
      listingId: listingId ? String(listingId) : null,
    },
  };
}

module.exports = {
  hideReview,
  restoreReview,
  cleanReason,
  ReviewModerationError,
  REASON_MIN,
  REASON_MAX,
};
