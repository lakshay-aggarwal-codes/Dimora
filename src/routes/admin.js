// /admin/... (mounted in src/app.js). Everything here is behind adminGuard.
// A route that changes data must be wrapped in auditedMutation (see
// src/middleware/admin.js); tests/unit/admin.routes.test.js fails otherwise.
// There is deliberately no route that edits or deletes an audit row.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { adminGuard } = require("../middleware/admin");
const controller = require("../controllers/admin");

const router = express.Router();
router.use(adminGuard);

router.get("/", controller.index);
router.get("/audit", wrapAsync(controller.auditLog));

module.exports = router;
