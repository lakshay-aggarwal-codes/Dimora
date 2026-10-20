// /host/listings/... (mounted in src/app.js): the listing wizard, the status
// page and the availability calendar.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn, authorize } = require("../middleware");
const controller = require("../controllers/host");
const availability = require("../controllers/availability");

const router = express.Router();
const mayCreate = [isLoggedIn, authorize("listing:create")];
const mayEdit = [isLoggedIn, authorize("listing:edit")];

router.get("/listings", isLoggedIn, wrapAsync(controller.myListings));

// "/new" must come before "/:id".
router.get("/listings/new", ...mayCreate, controller.newForm);
router.post("/listings", ...mayCreate, wrapAsync(controller.create));

router.get("/listings/:id", ...mayEdit, controller.resume);
router.get(
  "/listings/:id/steps/:n",
  ...mayEdit,
  wrapAsync(controller.showStep),
);
router.post(
  "/listings/:id/steps/:n",
  ...mayEdit,
  wrapAsync(controller.saveStep),
);
router.get("/listings/:id/status", ...mayEdit, controller.status);
router.post("/listings/:id/publish", ...mayEdit, wrapAsync(controller.publish));
router.post(
  "/listings/:id/unpublish",
  ...mayEdit,
  wrapAsync(controller.unpublish),
);

// Availability calendar (P07-T03): only the listing's host.
router.get(
  "/listings/:id/calendar",
  ...mayEdit,
  wrapAsync(availability.show),
);
router.post(
  "/listings/:id/calendar/blocks",
  ...mayEdit,
  wrapAsync(availability.block),
);
router.post(
  "/listings/:id/calendar/unblock",
  ...mayEdit,
  wrapAsync(availability.unblock),
);

module.exports = router;
