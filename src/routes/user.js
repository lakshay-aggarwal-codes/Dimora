const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const router = express.Router({ mergeParams: true });
const { saveRedirectUrl } = require("../middleware");
const userController = require("../controllers/user.js");

router
  .route("/signup")
  .get(userController.renderSignupForm)
  .post(wrapAsync(userController.signup));

router
  .route("/login")
  .get(userController.renderLoginForm)
  .post(saveRedirectUrl, userController.login);

// POST only: a link or an <img> on another site must not be able to log you out.
router.post("/logout", userController.logout);
module.exports = router;