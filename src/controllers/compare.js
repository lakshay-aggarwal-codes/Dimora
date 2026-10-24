// GET /compare (P10-T03). Public: it shows only what the listing pages show,
// and the link can be shared. The price depends on today's availability, so
// the page is never cached.
const service = require("../services/compare");

module.exports.show = async (req, res) => {
  const result = await service.compare({ query: req.query });
  res.set("Cache-Control", "no-store");
  res.render("compare/index.ejs", {
    ...result,
    pageTitle: "Compare stays",
    pageDescription: "Compare prices, rooms and amenities of the stays you shortlisted.",
  });
};
