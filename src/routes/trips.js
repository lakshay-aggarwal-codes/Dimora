// /trips and /trips/:id (P09-T01). Both need a signed-in member; the booking
// page then checks that this member may see that booking.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/trips");

const router = express.Router();

router.get("/trips", isLoggedIn, wrapAsync(controller.index));
router.get("/trips/:id", isLoggedIn, wrapAsync(controller.show));

module.exports = router;
