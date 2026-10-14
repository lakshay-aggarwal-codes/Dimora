const express = require("express");
const router = express.Router({ mergeParams: true });
const wrapAsync = require("../utils/wrapAsync");
const { validateReview, isLoggedIn, authorize } = require("../middleware");
const reviewController = require("../controllers/review.js")

router.post(
  "/",
  isLoggedIn,
  authorize("review:create"),
  validateReview,
  wrapAsync(reviewController.createReview),
);

//DELETE review ROutE
router.delete(
  "/:reviewId",
  isLoggedIn,
  authorize("review:delete"),
  wrapAsync(reviewController.destroyreview),
);
module.exports = router;
