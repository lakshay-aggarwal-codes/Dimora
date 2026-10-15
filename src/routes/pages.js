const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync");
const pagesController = require("../controllers/pages");

router.get("/", wrapAsync(pagesController.home));
router.get("/about", pagesController.about);
router.get("/privacy", pagesController.privacy);
router.get("/terms", pagesController.terms);

module.exports = router;
