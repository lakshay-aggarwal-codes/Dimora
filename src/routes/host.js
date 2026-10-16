// /host/listings/... (mounted in src/app.js): the listing wizard.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn, authorize } = require("../middleware");
const controller = require("../controllers/host");

const router = express.Router();
const mayCreate = [isLoggedIn, authorize("listing:create")];
const mayEdit = [isLoggedIn, authorize("listing:edit")];

// "/new" must come before "/:id".
router.get("/listings/new", ...mayCreate, controller.newForm);
router.post("/listings", ...mayCreate, wrapAsync(controller.create));

router.get("/listings/:id", ...mayEdit, controller.resume);
router.get("/listings/:id/steps/:n", ...mayEdit, wrapAsync(controller.showStep));
router.post("/listings/:id/steps/:n", ...mayEdit, wrapAsync(controller.saveStep));
router.post("/listings/:id/publish", ...mayEdit, wrapAsync(controller.publish));

module.exports = router;
