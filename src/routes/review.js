const express = require("express");
const router = express.Router({ mergeParams: true });
const wrapAsync = require("../utils/wrapAsync");
const {
  validateReview,
  validateReviewEdit,
  validateReviewReply,
  isLoggedIn,
  authorize,
} = require("../middleware");
const reviewController = require("../controllers/review.js")

router.post(
  "/",
  isLoggedIn,
  authorize("review:create"),
  validateReview,
  wrapAsync(reviewController.createReview),
);

// The author edits their review inside the edit window (P12-T03). The service
// decides the window; the policy decides whose review it is.
router.put(
  "/:reviewId",
  isLoggedIn,
  authorize("review:edit"),
  validateReviewEdit,
  wrapAsync(reviewController.updateReview),
);

// The host's reply (P12-T03). `review:reply` is decided on the listing in the
// URL (its owner), so these two routes load the listing, not the review.
router.post(
  "/:reviewId/reply",
  isLoggedIn,
  authorize("review:reply", { resource: "listing" }),
  validateReviewReply,
  wrapAsync(reviewController.createReply),
);
router.delete(
  "/:reviewId/reply",
  isLoggedIn,
  authorize("review:reply", { resource: "listing" }),
  wrapAsync(reviewController.destroyReply),
);

//DELETE review ROutE
router.delete(
  "/:reviewId",
  isLoggedIn,
  authorize("review:delete"),
  wrapAsync(reviewController.destroyreview),
);
module.exports = router;
