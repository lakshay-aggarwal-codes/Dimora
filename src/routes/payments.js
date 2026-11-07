// /trips/:id/pay (P16-T01): the simulated payment step of a booking. Both
// routes need a signed-in member; the controller then checks that this member
// is the booking's guest (anyone else gets a 404).
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/payments");

const router = express.Router();

router.get("/trips/:id/pay", isLoggedIn, wrapAsync(controller.show));
router.post("/trips/:id/pay", isLoggedIn, wrapAsync(controller.submit));

module.exports = router;
