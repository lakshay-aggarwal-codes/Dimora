const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync");
const availabilityController = require("../controllers/availabilityApi");
const quoteController = require("../controllers/quoteApi");
const searchController = require("../controllers/search");
const notificationsController = require("../controllers/notifications");

// Read-only JSON for the pages' scripts. Errors on /api paths are JSON too
// (see src/middleware/errors.js).
router.get(
  "/listings/:id/availability",
  wrapAsync(availabilityController.show),
);

router.get("/listings/:id/quote", wrapAsync(quoteController.show));

// Destination suggestions for the search boxes (P05-T06); public data only.
router.get("/destinations", wrapAsync(searchController.destinations));

// GeoJSON of the stays on the search map (P06-T04); public data only.
router.get("/search/map", wrapAsync(searchController.mapData));

// Unread count for the navbar bell (P11-T01); 401 JSON when signed out.
router.get("/notifications/count", wrapAsync(notificationsController.count));

module.exports = router;
