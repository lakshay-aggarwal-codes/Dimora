// Messaging routes (P11-T02). Mounted at "/" in src/app.js.
//
// JSON (answers 401 JSON when signed out; bodies are form-encoded, like every
// other POST in the app, and carry the CSRF token in X-CSRF-Token):
//   GET  /api/conversations                       the member's conversations
//   GET  /api/conversations/:id/messages?before=  one page of a thread
//   POST /api/conversations/:id/messages          body=...
//   POST /api/listings/:id/conversations          "Contact host"
//   POST /api/reservations/:id/conversation       the thread of one booking
// Pages (a visitor is sent to the login page):
//   POST /listings/:id/contact, GET /conversations/:id,
//   POST /conversations/:id/messages
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const controller = require("../controllers/conversations");

const router = express.Router();

router.get("/api/conversations", wrapAsync(controller.apiList));
router.get("/api/conversations/:id/messages", wrapAsync(controller.apiThread));
router.post("/api/conversations/:id/messages", wrapAsync(controller.apiSend));
router.post(
  "/api/listings/:id/conversations",
  wrapAsync(controller.apiStartForListing),
);
router.post(
  "/api/reservations/:id/conversation",
  wrapAsync(controller.apiStartForReservation),
);

router.post("/listings/:id/contact", isLoggedIn, wrapAsync(controller.contact));
router.get("/conversations/:id", isLoggedIn, wrapAsync(controller.show));
router.post(
  "/conversations/:id/messages",
  isLoggedIn,
  wrapAsync(controller.sendForm),
);

module.exports = router;
