// JSON endpoints used by the pages' scripts (read-only).
const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const searchController = require("../controllers/search");

const router = express.Router();

// Map data for the listings page (P06-T04).
router.get("/search/map", wrapAsync(searchController.mapData));

module.exports = router;
