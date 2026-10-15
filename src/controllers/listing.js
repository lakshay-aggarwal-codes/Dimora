const Listing = require("../models/listing.js");
const { getGeocodingClient } = require("../services/geocoding");
const { deleteImage } = require("../config/cloudinary");
const { toMapPoint } = require("../utils/geo");

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

  const newListing = new Listing({
    title,
    description,
    location,
    country,
    price,
    owner: req.user._id,
    geometry: req.geometry,
    image: { url: req.file.path, filename: req.file.filename },
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
  const imageUrl = listing.image && listing.image.url;
  const originalImageUrl = imageUrl
    ? imageUrl.replace("/upload", "/upload/w_250")
    : null;
  res.render("listings/edit.ejs", {
    listing,
    originalImageUrl,
    pageTitle: `Edit ${listing.title}`,
  });
};

// The image is optional on edit: without a new file the stored image stays.
// With one, the old image is deleted from Cloudinary after the save succeeds.
module.exports.updateListing = async (req, res) => {
  const { id } = req.params;
  const listing = req.listing; // loaded by authorize("listing:edit")
  const { title, description, location, country, price } = req.body.listing;

  const previousFilename = listing.image && listing.image.filename;

  listing.set({ title, description, location, country, price });
  if (req.geometry) listing.geometry = req.geometry;
  if (req.file) {
    listing.image = { url: req.file.path, filename: req.file.filename };
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
