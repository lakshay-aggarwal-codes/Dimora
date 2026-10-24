const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Review model v2 (P12-T01). A new review belongs to one completed
// reservation: `reservation` is set, `legacy` is false, and a partial unique
// index allows one review per reservation. Reviews written before bookings
// existed have no reservation and are marked `legacy: true` by migration 008
// (ADR-010); they keep their content and are shown with a note.
//
// `listing` is the listing that was stayed in. It is kept even if the listing
// is later deleted, together with `listingSnapshot` (title and city when the
// review was written), so a review never loses what it was about.
const reviewSchema = new Schema(
  {
    comment: String,
    rating: {
      type: Number,
      min: 1,
      max: 5,
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    listing: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
    },
    reservation: {
      type: Schema.Types.ObjectId,
      ref: "Reservation",
    },
    legacy: {
      type: Boolean,
      default: false,
    },
    // Moderation (P14-T04). A hidden review is not shown on the listing and is
    // not in the listing's rating totals; its stay still counts as reviewed, so
    // the guest cannot simply write another. Reviews written before this field
    // existed have no status and are visible.
    status: {
      type: String,
      enum: ["visible", "hidden"],
      default: "visible",
    },
    moderation: {
      hiddenAt: Date,
      hiddenBy: { type: Schema.Types.ObjectId, ref: "User" },
      hiddenReason: { type: String, trim: true, maxlength: 500 },
    },
    listingSnapshot: {
      title: String,
      city: String,
    },
  },
  { timestamps: true },
);

// One review per reservation. Partial, so legacy reviews (no reservation) do
// not collide. Built by migration 008 and by the model at startup.
reviewSchema.index(
  { reservation: 1 },
  {
    name: "reservation_1_unique",
    unique: true,
    partialFilterExpression: { reservation: { $type: "objectId" } },
  },
);
// A listing's reviews, newest first (the listing page and its aggregates).
reviewSchema.index(
  { listing: 1, createdAt: -1 },
  { name: "listing_1_createdAt_-1" },
);
reviewSchema.index(
  { author: 1, createdAt: -1 },
  { name: "author_1_createdAt_-1" },
);

module.exports = mongoose.model("Review", reviewSchema);
