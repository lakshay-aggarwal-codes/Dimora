// Email confirmation and password reset (P02-T05). CSRF is checked for the POSTs
// by the app-wide middleware; rate limits are mounted in src/app.js.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/emailAuth");

const router = express.Router();

// "/needed" before "/:token".
router.get("/verify-email/needed", isLoggedIn, controller.showNeeded);
router.post("/verify-email/resend", isLoggedIn, wrapAsync(controller.resend));
router.get("/verify-email/:token", wrapAsync(controller.showVerify));
router.post("/verify-email", wrapAsync(controller.verify));

router.route("/forgot-password").get(controller.showForgot).post(wrapAsync(controller.forgot));
router.get("/reset-password/:token", wrapAsync(controller.showReset));
router.post("/reset-password", wrapAsync(controller.reset));

module.exports = router;
