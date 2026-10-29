// Saved stays (P10-T01). Both routes need a signed-in member; the data is
// always the member's own (queries filter on req.user), so there is no id of
// someone else's list to guess.
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const { isLoggedIn } = require("../middleware");
const { withSavedIds } = require("../middleware/savedIds");
const controller = require("../controllers/wishlists");

const router = express.Router();

router.get("/wishlists", isLoggedIn, withSavedIds, wrapAsync(controller.index));
router.post("/listings/:id/save", isLoggedIn, wrapAsync(controller.save));

// Named lists, moving stays and notes (P10-T02). The services only ever touch
// the signed-in member's own lists.
router.post("/wishlists", isLoggedIn, wrapAsync(controller.createList));
router.post("/wishlists/:id/rename", isLoggedIn, wrapAsync(controller.renameList));
router.post("/wishlists/:id/delete", isLoggedIn, wrapAsync(controller.deleteList));
router.post("/wishlists/:id/items/:listingId/move", isLoggedIn, wrapAsync(controller.moveItem));
router.post("/wishlists/:id/items/:listingId/note", isLoggedIn, wrapAsync(controller.setNote));

// Read-only share links (P10-T04): the owner makes and revokes the link; the
// public page is a plain GET that changes nothing.
router.post("/wishlists/:id/share", isLoggedIn, wrapAsync(controller.share));
router.post("/wishlists/:id/share/revoke", isLoggedIn, wrapAsync(controller.revokeShare));
router.get("/shared/lists/:token", wrapAsync(controller.showShared));

// Saved searches (P10-T02).
router.get("/saved-searches", isLoggedIn, wrapAsync(controller.searchesIndex));
router.post("/saved-searches", isLoggedIn, wrapAsync(controller.saveSearch));
router.post("/saved-searches/:id/delete", isLoggedIn, wrapAsync(controller.deleteSearch));

module.exports = router;
