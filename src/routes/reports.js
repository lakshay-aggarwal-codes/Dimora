// /reports (P12-T04): the report form, sending a report, and the reporter's own
// list with each report's status. All need a signed-in member; the per-minute
// limiter for POST /reports is mounted in src/app.js.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/reports");

const router = express.Router();

router.get("/reports", isLoggedIn, wrapAsync(controller.index));
// "/new" before anything with a parameter.
router.get("/reports/new", isLoggedIn, wrapAsync(controller.newForm));
router.post("/reports", isLoggedIn, wrapAsync(controller.create));

module.exports = router;
