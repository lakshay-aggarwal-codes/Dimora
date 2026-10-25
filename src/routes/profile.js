// /users/:id (public) and /account/profile (the signed-in member's own).
const express = require("express");
const { inputGuard } = require("../middleware/inputGuard");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const { upload } = require("../config/cloudinary");
const controller = require("../controllers/profile");

const router = express.Router();

router.get("/users/:id", wrapAsync(controller.show));

router.get("/account/profile", isLoggedIn, controller.editForm);
// Multipart, so the CSRF token travels in the query string (as on the other upload forms).
router.put(
  "/account/profile",
  isLoggedIn,
  upload.single("avatar"),
  inputGuard,
  wrapAsync(controller.update),
);

module.exports = router;
