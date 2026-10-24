const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync");
const { withSavedIds } = require("../middleware/savedIds");
const pagesController = require("../controllers/pages");

router.get("/", withSavedIds, wrapAsync(pagesController.home));
router.get("/about", pagesController.about);
router.get("/privacy", pagesController.privacy);
router.get("/terms", pagesController.terms);

module.exports = router;
