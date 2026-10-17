const Review = require("../models/review.js");
const Listing = require("../models/listing.js");
const { isPublic } = require("../utils/visibility");
const { NotFoundError } = require("../utils/errors");

module.exports.createReview = async (req, res) => {
  let listing = await Listing.findById(req.params.id);
  // Nobody reviews a draft, an unpublished or a deleted listing.
  if (!isPublic(listing))
    throw new NotFoundError("That listing does not exist.");
  let newReview = new Review(req.body.review);
  newReview.author = req.user._id;
  listing.reviews.push(newReview);

  await newReview.save();
  await listing.save();

  req.flash("success", "New Review Created");
  res.redirect(`/listings/${listing._id}`);
};

module.exports.destroyreview = async (req, res) => {
  let { id, reviewId } = req.params;
  await Listing.findByIdAndUpdate(id, { $pull: { reviews: reviewId } });
  await Review.findByIdAndDelete(reviewId);
  req.flash("success", "Review Deleted");
  res.redirect(`/listings/${id}`);
};
