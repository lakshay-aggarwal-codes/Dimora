const Listing = require("../models/listing.js");
const reviewService = require("../services/reviews");
const { publicListingFilter } = require("../utils/visibility");

// A review belongs to one completed stay (P12-T01, ADR-010): the form sends
// the reservation, and the service decides whether this person may review it.
module.exports.createReview = async (req, res) => {
  const { reservation, rating, comment } = req.body.review;
  await reviewService.submit({
    user: req.user,
    listingId: req.params.id,
    reservationId: reservation,
    rating,
    comment,
    windowDays: req.app.locals.reviewWindowDays,
  });

  req.flash("success", "Thank you, your review was added.");
  // A stay at a listing that has since been taken down is still reviewable;
  // there is no listing page to return to then.
  const stillPublic = await Listing.exists({
    _id: req.params.id,
    ...publicListingFilter(),
  });
  res.redirect(
    stillPublic ? `/listings/${req.params.id}` : `/trips/${reservation}`,
  );
};

module.exports.destroyreview = async (req, res) => {
  const { id, reviewId } = req.params;
  // One service call: deletes the review and updates the listing's list and
  // rating totals together (P12-T02).
  await reviewService.remove({ listingId: id, reviewId });
  req.flash("success", "Review Deleted");
  res.redirect(`/listings/${id}`);
};
