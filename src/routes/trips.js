// /trips and /trips/:id (P09-T01). Both need a signed-in member; the booking
// page then checks that this member may see that booking.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/trips");

const router = express.Router();

router.get("/trips", isLoggedIn, wrapAsync(controller.index));
router.get("/trips/:id", isLoggedIn, wrapAsync(controller.show));
// The guest cancels (P09-T03); the service decides who may and what is refunded.
router.post("/trips/:id/cancel", isLoggedIn, wrapAsync(controller.cancel));
// The guest changes the dates (P09-T04): the page shows the new price and the
// difference first, the POST applies it. The service decides who may.
router.get("/trips/:id/change", isLoggedIn, wrapAsync(controller.changeForm));
router.post("/trips/:id/change", isLoggedIn, wrapAsync(controller.change));

module.exports = router;
