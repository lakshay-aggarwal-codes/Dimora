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

module.exports = router;
