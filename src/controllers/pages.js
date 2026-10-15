const Listing = require("../models/listing.js");
const { loadHomeData } = require("../services/home");

module.exports.home = async (req, res) => {
  const { featured, destinations } = await loadHomeData(Listing);
  res.render("pages/home.ejs", {
    featured,
    destinations,
    pageTitle: "Find a place to stay",
    pageDescription:
      "Search stays by place, see the price clearly, or list your own home on Dimora, a college project.",
  });
};

module.exports.about = (req, res) =>
  res.render("pages/about.ejs", {
    pageTitle: "About Dimora",
    pageDescription:
      "Dimora is a college project: a small marketplace where people list homes and find places to stay.",
  });

module.exports.privacy = (req, res) =>
  res.render("pages/privacy.ejs", {
    pageTitle: "Privacy Policy",
    pageDescription:
      "What Dimora stores about you, why, who else sees it, and how to ask for it to be removed.",
  });

module.exports.terms = (req, res) =>
  res.render("pages/terms.ejs", {
    pageTitle: "Terms of Service",
    pageDescription:
      "Plain-language rules for using Dimora, a college project with no real bookings or payments.",
  });
