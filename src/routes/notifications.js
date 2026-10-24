// /notifications (P11-T01): the member's inbox. Everything needs a signed-in
// member; the service only ever touches that member's own rows. The unread
// count for the bell is GET /api/notifications/count (src/routes/api.js).
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/notifications");

const router = express.Router();

router.get("/notifications", isLoggedIn, wrapAsync(controller.index));
// "read-all" is a path of its own and cannot be mistaken for an id.
router.post(
  "/notifications/read-all",
  isLoggedIn,
  wrapAsync(controller.markAllRead),
);
router.post(
  "/notifications/:id/read",
  isLoggedIn,
  wrapAsync(controller.markRead),
);

module.exports = router;
