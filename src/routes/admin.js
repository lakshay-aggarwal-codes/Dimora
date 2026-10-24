// /admin/... (mounted in src/app.js). Everything here is behind adminGuard.
// A route that changes data must be wrapped in auditedMutation (see
// src/middleware/admin.js); tests/unit/admin.routes.test.js fails otherwise.
// There is deliberately no route that edits or deletes an audit row.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { adminGuard, auditedMutation } = require("../middleware/admin");
const controller = require("../controllers/admin");

const router = express.Router();
router.use(adminGuard);

router.get("/", controller.index);
router.get("/audit", wrapAsync(controller.auditLog));

router.get("/users", wrapAsync(controller.users));
router.get("/users/:id", wrapAsync(controller.user));
router.post("/users/:id/suspend", auditedMutation(controller.suspendUser));
router.post("/users/:id/reinstate", auditedMutation(controller.reinstateUser));

router.get("/listings", wrapAsync(controller.listings));
router.get("/listings/:id", wrapAsync(controller.listing));
router.post("/listings/:id/suspend", auditedMutation(controller.suspendListing));
router.post("/listings/:id/restore", auditedMutation(controller.restoreListing));
router.post("/listings/:id/reviewed", auditedMutation(controller.reviewListing));

module.exports = router;
