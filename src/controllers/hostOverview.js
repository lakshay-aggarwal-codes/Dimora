// GET /host: the signed-in host's overview tiles.
const hostOverview = require("../services/hostOverview");
const { formatStayDate, formatInstant } = require("../services/trips");

module.exports.show = async (req, res) => {
  const data = await hostOverview.overview({}, req.user._id);
  res.render("host/overview.ejs", {
    data,
    formatStayDate,
    formatInstant,
    pageTitle: "Host overview",
    pageDescription: "What needs you today.",
  });
};
