const express = require("express");
const router = express.Router();

// Home: redirect to the listings until the real home page exists (P03-T05).
router.get("/", (req, res) => res.redirect("/listings"));

// Placeholders so the footer links do not 404; real content comes later.
router.get("/privacy", (req, res) =>
  res.render("pages/placeholder.ejs", { pageTitle: "Privacy Policy" }),
);
router.get("/terms", (req, res) =>
  res.render("pages/placeholder.ejs", { pageTitle: "Terms of Service" }),
);

module.exports = router;
