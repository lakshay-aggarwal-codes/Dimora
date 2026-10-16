const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync");
const {
  isLoggedIn,
  authorize,
  validateListing,
} = require("../middleware");
const {
  requireImage,
  verifyUploadedImage,
  geocodeListing,
} = require("../middleware/listing");
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
    authorize("listing:create"),
    upload.single(IMAGE_FIELD),
    validateListing,
    requireImage,
    verifyUploadedImage,
    geocodeListing({ backTo: () => "/listings/new" }),
    uploadToCloudinary,
    wrapAsync(listingController.createListing),
  );

// EDIT - Show edit form
router.get(
  "/:id/edit",
  isLoggedIn,
  authorize("listing:edit"),
  wrapAsync(listingController.renderEditForm),
);

router.get(
  "/new",
  isLoggedIn,
  authorize("listing:create"),
  listingController.renderNewForm,
);

router
  .route("/:id")
  .get(wrapAsync(listingController.showListings))
  .put(
    isLoggedIn,
    authorize("listing:edit"),
    upload.single(IMAGE_FIELD),
    validateListing,
    verifyUploadedImage,
    geocodeListing({ backTo: (req) => `/listings/${req.params.id}/edit` }),
    uploadToCloudinary,
    wrapAsync(listingController.updateListing),
  )
  .delete(
    isLoggedIn,
    authorize("listing:delete"),
    wrapAsync(listingController.destroyListing),
  );

module.exports = router;
