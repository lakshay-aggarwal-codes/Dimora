// /account (P02-T04): signed-in members only; CSRF is checked for the POSTs by
// the app-wide middleware.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/account");

const router = express.Router();

router.get("/account", isLoggedIn, wrapAsync(controller.show));
router.post(
  "/account/password",
  isLoggedIn,
  wrapAsync(controller.changePassword),
);
router.post("/account/delete", isLoggedIn, wrapAsync(controller.deleteAccount));

module.exports = router;
