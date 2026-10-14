const Listing = require("../models/listing.js");
const Review = require("../models/review.js");
const { ValidationError, NotFoundError } = require("../utils/errors");
const { listingSchema, reviewSchema } = require("../validation");

module.exports.isLoggedIn = (req, res, next) => {
  if (!req.isAuthenticated()) {
    req.session.redirectUrl = req.originalUrl;
    req.flash("error", "You must be logged in to do that");
    return res.redirect("/login");
  }
  next();
};
module.exports.saveRedirectUrl = (req, res, next) => {
  if (req.session.redirectUrl) {
    res.locals.redirectUrl = req.session.redirectUrl;
    delete req.session.redirectUrl;
  }
  next();
};

// Loads the listing and checks that the logged-in user owns it. The listing is
// left on req.listing so later steps do not fetch it again.
module.exports.isOwner = async (req, res, next) => {
  const { id } = req.params;
  const listing = await Listing.findById(id);
  if (!listing) {
    throw new NotFoundError("That listing does not exist.");
  }
  // A listing without an owner (old seed data) belongs to nobody.
  if (!listing.owner || !listing.owner.equals(req.user._id)) {
    req.flash("error", "You aren't the owner of this listing");
    return res.redirect(`/listings/${id}`);
  }
  req.listing = listing;
  next();
};

module.exports.validateListing = (req, res, next) => {
  // `?? {}`: a request with no parsable body must fail validation, not crash.
  const { error, value } = listingSchema.validate(req.body ?? {});
  if (error) {
    let errMsg = error.details.map((el) => el.message).join(",");
    throw new ValidationError(errMsg);
  }
  req.body = value; // trimmed strings, price as a number
  next();
};

module.exports.validateReview = (req, res, next) => {
  let { error } = reviewSchema.validate(req.body);
  if (error) {
    let errMsg = error.details.map((el) => el.message).join(",");
    throw new ValidationError(errMsg);
  } else next();
};

module.exports.isReviewAuthor = async (req, res, next) => {
  let { id, reviewId } = req.params;
  let review = await Review.findById(reviewId);
  if (!review.author.equals(res.locals.currUser._id)) {
    req.flash("error", "You aren't the author of this review");
    return res.redirect(`/listings/${id}`);
  }
  next();
};
