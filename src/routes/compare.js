const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const controller = require("../controllers/compare");

const router = express.Router();
router.get("/compare", wrapAsync(controller.show));

module.exports = router;
