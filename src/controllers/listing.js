const Listing = require("../models/listing.js");
const reviewService = require("../services/reviews");
const { can } = require("../policies");
const { searchPage } = require("../services/search");
const { isAdmin } = require("../policies/shared");
const { getGeocodingClient } = require("../services/geocoding");
const { deleteImage } = require("../config/cloudinary");
const { galleryOf, replaceCover } = require("../services/images");
const { publicPointOf } = require("../utils/geo");
const { isPublic } = require("../utils/visibility");
const { softDeleteListing } = require("../services/lifecycle");
const { stayRulesFor } = require("../services/bookingRules");
const { todayIn, tryParseDateOnly, formatDateOnly } = require("../utils/dates");
const { evaluateReadiness } = require("../services/readiness");
const { NotFoundError, ConflictError } = require("../utils/errors");
const {
  rupeesToMinor,
  addressFromLegacy,
  imagesFromCover,
} = require("../utils/listingFields");

// The sort choices offered on the listings page, in the order shown.
const SORT_OPTIONS = [
  { value: "relevance", label: "Best match" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "rating", label: "Top rated" },
  { value: "newest", label: "Newest" },
];

// server.js calls this at startup so a malformed MAPBOX_SERVER_TOKEN still
// stops the server at boot (the client is otherwise built on first use).
module.exports.initGeocoding = getGeocodingClient;

module.exports.index = async (req, res) => {
  // Only published listings are public (the search filter says so); results are
  // sorted and 12 to a page. The URL names and filter forms are P05-T02/T04.
  const results = await searchPage(Listing, req.query);
  res.render("listings/index.ejs", {
    allListings: results.listings,
    results,
    sortOptions: SORT_OPTIONS,
    pageTitle:
      results.page > 1 && !results.outOfRange
        ? `Explore stays (page ${results.page})`
        : "Explore stays",
    pageDescription: "Browse places to stay on Dimora.",
  });
};

module.exports.renderNewForm = (req, res) => {
  res.render("listings/new.ejs", {
    pageTitle: "List your place",
    pageDescription: "Add your home to Dimora and welcome guests.",
  });
};

// What the date picker on the detail page needs. The dates in `?in=&out=` (from
// a search) pre-fill it, but only real YYYY-MM-DD strings are used; the script
// re-checks them against the availability data.
function datePickerFor(listing, query) {
  const rules = stayRulesFor(listing, { today: todayIn() });
  const read = (value) => {
    const date = typeof value === "string" ? tryParseDateOnly(value) : null;
    return date ? formatDateOnly(date) : "";
  };
  // The booking panel (P08-T02): how many guests the select offers and which
  // one starts selected (`?guests=`, kept inside 1..capacity).
  const capacity = Number.isInteger(rules.capacity) && rules.capacity >= 1 ? rules.capacity : 1;
  const wanted =
    typeof query.guests === "string" && /^\d{1,3}$/.test(query.guests) ? Number(query.guests) : 2;
  return {
    url: `/api/listings/${listing._id}/availability`,
    rules,
    initialIn: read(query.in),
    initialOut: read(query.out),
    quote: {
      url: `/api/listings/${listing._id}/quote`,
      checkoutUrl: `/listings/${listing._id}/checkout`,
      capacity,
      guests: Math.min(Math.max(wanted, 1), capacity),
    },
  };
}

module.exports.showListings = async (req, res) => {
  const { id } = req.params;

  const listing = await Listing.findById(id)
    .populate({
      path: "reviews",
      populate: {
        path: "author",
      },
    })
    .populate("owner");
  // ?preview=1 is the host's "see it as a guest" view: only the host, and a
  // plain 404 for everybody else (it never reveals that the listing exists).
  const preview = req.query.preview === "1";
  if (
    preview &&
    (!listing || listing.deletedAt || !can("listing:edit", req.user, listing))
  ) {
    throw new NotFoundError("That listing does not exist.");
  }

  // A deleted listing is gone for everyone. A draft or unpublished one is
  // visible to its host and to admins only; to everyone else it looks exactly
  // like a listing that does not exist.
  const visible =
    listing &&
    !listing.deletedAt &&
    (isPublic(listing) ||
      can("listing:edit", req.user, listing) ||
      isAdmin(req.user));
  if (!visible) {
    req.flash("error", "Listing you requested for does not exist");
    return res.redirect("/listings");
  }

  // Only the validated coordinates reach the page (as data- attributes); the
  // whole listing document is never serialised into a script.
  // Offer the review form only to a guest with a completed, unreviewed stay
  // inside the review window (P12-T01). `submit` decides again on the POST.
  const reviewable =
    req.user && !preview
      ? await reviewService.findReviewable({
          user: req.user,
          listingId: listing._id,
          windowDays: req.app.locals.reviewWindowDays,
        })
      : null;

  res.render("listings/show.ejs", {
    listing,
    reviewable,
    gallery: galleryOf(listing),
    // The public (approximate) point only: the precise one never reaches a page.
    mapPoint: publicPointOf(listing),
    guestView: preview,
    datePicker: datePickerFor(listing, req.query),
    readiness:
      !isPublic(listing) && can("listing:edit", req.user, listing)
        ? evaluateReadiness(listing)
        : null,
    pageTitle: listing.title,
    pageDescription: listing.description,
  });
};
// Runs after validateListing, requireImage, geocodeListing and uploadToCloudinary
// (see routes/listing.js): req.body.listing is clean, req.geometry is set and
// req.file.path / req.file.filename point at the uploaded image.
module.exports.createListing = async (req, res) => {
  const { title, description, location, country, price } = req.body.listing;
  const cover = { url: req.file.path, filename: req.file.filename };

  const newListing = new Listing({
    title,
    description,
    location,
    country,
    // The old form has no draft step, so a listing is public as soon as it is
    // saved. The wizard (P04-T02) creates drafts and P04-T05 publishes them.
    status: "published",
    pricing: { nightlyMinor: rupeesToMinor(price), currency: "INR" },
    // The form asks for free text; the structured address is a guess the host
    // confirms later (P04-T04).
    address: addressFromLegacy(location, country),
    needsReview: true,
    owner: req.user._id,
    geometry: req.geometry,
    image: cover,
    images: imagesFromCover(cover),
  });

  try {
    await newListing.save();
  } catch (err) {
    await deleteImage(req.file.filename, req.log); // do not orphan the upload
    throw err;
  }

  req.flash("success", "New Listing Created");
  res.redirect("/listings");
};
// The image is optional on edit: without a new file the stored image stays.
// With one, the old image is deleted from Cloudinary after the save succeeds.
module.exports.updateListing = async (req, res) => {
  const { id } = req.params;
  const listing = req.listing; // loaded by authorize("listing:edit")
  const { title, description, location, country, price } = req.body.listing;

  let previousFilename;

  listing.set({ title, description, location, country });
  listing.set("pricing.nightlyMinor", rupeesToMinor(price));
  // While the address is still the guess made from the old text fields, keep it
  // in step with them; a confirmed address (needsReview false) is left alone.
  if (listing.needsReview)
    listing.address = addressFromLegacy(location, country);
  if (req.geometry) listing.geometry = req.geometry;
  if (req.file) {
    // The single-photo field replaces the cover; the rest of the gallery stays.
    previousFilename = replaceCover(listing, {
      url: req.file.path,
      publicId: req.file.filename,
    });
  }

  try {
    await listing.save();
  } catch (err) {
    if (req.file) await deleteImage(req.file.filename, req.log);
    throw err;
  }

  if (req.file && previousFilename) {
    await deleteImage(previousFilename, req.log);
  }

  req.flash("success", "Listing Updated");
  res.redirect(`/listings/${id}`);
};

module.exports.destroyListing = async (req, res) => {
  const { id } = req.params;

  // Soft delete (P04-T05): hidden for good, but the row stays so reviews and
  // reservations remain readable. Refused while a reservation is upcoming.
  try {
    await softDeleteListing(req.listing || (await Listing.findById(id)));
  } catch (err) {
    if (err instanceof ConflictError) {
      req.flash("error", err.message);
      return res.redirect(`/host/listings/${id}/status`);
    }
    throw err;
  }
  req.flash("success", "Listing Deleted");

  res.redirect(`/listings`);
};
