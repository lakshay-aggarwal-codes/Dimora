const express = require("express");
const router = express.Router({ mergeParams: true });
const wrapAsync = require("../utils/wrapAsync");
const Review = require("../models/review.js");
const Listing = require("../models/listing.js");
const { validateReview, isLoggedIn, isReviewAuthor } = require("../middleware.js");
const reviewController = require("../controllers/review.js")

router.post(
  "/",
  isLoggedIn,
  validateReview,
  wrapAsync(reviewController.createReview),
);

//DELETE review ROutE
router.delete(
  "/:reviewId",
  isLoggedIn,
  isReviewAuthor,
  wrapAsync(reviewController.destroyreview),
);
module.exports = router;
