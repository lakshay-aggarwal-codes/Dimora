// Email preferences (P11-T05). CSRF is checked for the POSTs by the app-wide
// middleware; the unsubscribe routes are public because the link in an email is
// the credential (a signed token, see services/notificationEmail.js).
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/notificationPrefs");

const router = express.Router();

router.get("/account/notifications", isLoggedIn, controller.show);
router.post("/account/notifications", isLoggedIn, wrapAsync(controller.save));
router.get("/email/unsubscribe/:token", controller.showUnsubscribe);
router.post("/email/unsubscribe", wrapAsync(controller.unsubscribe));

module.exports = router;
