const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn, isOwner, validateListing } = require("../middleware");
const { requireImage, geocodeListing } = require("../middleware/listing");
const listingController = require("../controllers/listing.js");
const { upload, uploadToCloudinary } = require("../config/cloudinary");

// The file input in the new/edit forms is named like a nested field.
const IMAGE_FIELD = "listing[image][url]";

// Order matters: parse the multipart form first (so req.body exists), validate
// and geocode, and only then upload to Cloudinary, so a rejected submission
// never leaves an orphaned image behind.
router
  .route("/")
  .get(wrapAsync(listingController.index))
  .post(
    isLoggedIn,
    upload.single(IMAGE_FIELD),
    validateListing,
    requireImage,
    geocodeListing({ backTo: () => "/listings/new" }),
    uploadToCloudinary,
    wrapAsync(listingController.createListing),
  );

// EDIT - Show edit form
router.get(
  "/:id/edit",
  isLoggedIn,
  isOwner,
  wrapAsync(listingController.renderEditForm),
);

router.get("/new", isLoggedIn, listingController.renderNewForm);

router
  .route("/:id")
  .get(wrapAsync(listingController.showListings))
  .put(
    isLoggedIn,
    isOwner,
    upload.single(IMAGE_FIELD),
    validateListing,
    geocodeListing({ backTo: (req) => `/listings/${req.params.id}/edit` }),
    uploadToCloudinary,
    wrapAsync(listingController.updateListing),
  )
  .delete(isLoggedIn, isOwner, wrapAsync(listingController.destroyListing));

module.exports = router;
