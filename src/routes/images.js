// /listings/:id/images/... (mounted in src/app.js). Only someone who may edit
// the listing gets in; the listing is loaded by authorize("listing:edit").
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn, authorize } = require("../middleware");
const { uploadPhotos } = require("../config/cloudinary");
const { inputGuard } = require("../middleware/inputGuard");
const controller = require("../controllers/images");

const router = express.Router({ mergeParams: true });
const mayEdit = [isLoggedIn, authorize("listing:edit")];

// The upload form is multipart, so its CSRF token travels in the query string.
router.post(
  "/",
  ...mayEdit,
  uploadPhotos.array("photos"),
  inputGuard,
  wrapAsync(controller.upload),
);

// "/order" must come before "/:imageId".
router.put("/order", ...mayEdit, wrapAsync(controller.reorder));
router.put("/:imageId", ...mayEdit, wrapAsync(controller.updateText));
router.put("/:imageId/cover", ...mayEdit, wrapAsync(controller.makeCover));
router.put("/:imageId/move", ...mayEdit, wrapAsync(controller.move));
router.delete("/:imageId", ...mayEdit, wrapAsync(controller.remove));

module.exports = router;
