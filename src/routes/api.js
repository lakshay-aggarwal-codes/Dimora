const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync");
const availabilityController = require("../controllers/availabilityApi");
const quoteController = require("../controllers/quoteApi");

// Read-only JSON for the pages' scripts. Errors on /api paths are JSON too
// (see src/middleware/errors.js).
router.get(
  "/listings/:id/availability",
  wrapAsync(availabilityController.show),
);

router.get("/listings/:id/quote", wrapAsync(quoteController.show));

module.exports = router;
