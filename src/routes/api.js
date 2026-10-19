const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync");
const availabilityController = require("../controllers/availability");

// Read-only JSON for the pages' scripts. Errors on /api paths are JSON too
// (see src/middleware/errors.js).
router.get(
  "/listings/:id/availability",
  wrapAsync(availabilityController.show),
);

module.exports = router;
