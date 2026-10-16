const Listing = require("../models/listing.js");
const { getGeocodingClient } = require("../services/geocoding");
const { deleteImage } = require("../config/cloudinary");
const { galleryOf, replaceCover } = require("../services/images");
const { toMapPoint } = require("../utils/geo");
const { imageUrl } = require("../utils/imageUrl");
const {
  rupeesToMinor,
  minorToRupees,
  addressFromLegacy,
  imagesFromCover,
} = require("../utils/listingFields");

// server.js calls this at startup so a malformed MAPBOX_SERVER_TOKEN still
// stops the server at boot (the client is otherwise built on first use).
module.exports.initGeocoding = getGeocodingClient;

module.exports.index = async (req, res) => {
  const allListings = await Listing.find({});
  res.render("listings/index.ejs", {
    allListings,
    pageTitle: "Explore stays",
    pageDescription: "Browse places to stay on Dimora.",
  });
};

module.exports.renderNewForm = (req, res) => {
  res.render("listings/new.ejs", {
    pageTitle: "List your place",
    pageDescription: "Add your home to Dimora and welcome guests.",
  });
};

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
  if (!listing) {
    req.flash("error", "Listing you requested for does not exist");
    return res.redirect("/listings");
  }

  // Only the validated coordinates reach the page (as data- attributes); the
  // whole listing document is never serialised into a script.
  res.render("listings/show.ejs", {
    listing,
    gallery: galleryOf(listing),
    mapPoint: toMapPoint(listing.geometry),
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
module.exports.renderEditForm = async (req, res) => {
  const { id } = req.params;

  const listing = await Listing.findById(id);
  if (!listing) {
    req.flash("error", "Listing you requested for does not exist");
    return res.redirect("/listings");
  }
  const gallery = galleryOf(listing);
  res.render("listings/edit.ejs", {
    listing,
    gallery,
    priceRupees: minorToRupees(listing.pricing && listing.pricing.nightlyMinor),
    originalImageUrl: gallery.length ? imageUrl(gallery[0].url, "edit") : null,
    pageTitle: `Edit ${listing.title}`,
  });
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

  await Listing.findByIdAndDelete(id);
  req.flash("success", "Listing Deleted");

  res.redirect(`/listings`);
};
