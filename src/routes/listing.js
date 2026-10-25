const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync");
const { inputGuard } = require("../middleware/inputGuard");
const { withSavedIds } = require("../middleware/savedIds");
const { isLoggedIn, authorize, validateListing } = require("../middleware");
const {
  requireImage,
  verifyUploadedImage,
  geocodeListing,
} = require("../middleware/listing");
const searchController = require("../controllers/search");
const listingController = require("../controllers/listing.js");
const sectionsController = require("../controllers/sections");
const checkoutController = require("../controllers/checkout");
const { upload, uploadToCloudinary } = require("../config/cloudinary");

// The file input in the new/edit forms is named like a nested field.
const IMAGE_FIELD = "listing[image][url]";

// Order matters: parse the multipart form first (so req.body exists), validate
// and geocode, and only then upload to Cloudinary, so a rejected submission
// never leaves an orphaned image behind.
router
  .route("/")
  .get(withSavedIds, wrapAsync(searchController.index))
  .post(
    isLoggedIn,
    authorize("listing:create"),
    upload.single(IMAGE_FIELD),
    inputGuard,
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
  wrapAsync(sectionsController.renderEditForm),
);

// Checkout (P08-T03): the guest reviews the stay and the final price, then
// books. Both need a login; a guest who is logged out is sent back here after
// logging in.
router
  .route("/:id/checkout")
  .get(isLoggedIn, wrapAsync(checkoutController.show))
  .post(isLoggedIn, wrapAsync(checkoutController.submit));

router.get(
  "/new",
  isLoggedIn,
  authorize("listing:create"),
  listingController.renderNewForm,
);
router.put(
  "/:id/sections/:key",
  isLoggedIn,
  authorize("listing:edit"),
  wrapAsync(sectionsController.save),
);

router
  .route("/:id")
  .get(withSavedIds, wrapAsync(listingController.showListings))
  .put(
    isLoggedIn,
    authorize("listing:edit"),
    upload.single(IMAGE_FIELD),
    inputGuard,
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
