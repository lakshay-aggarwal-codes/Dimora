// GET /host/calendar?month=YYYY-MM: every listing of the signed-in host in one month.
const { monthOverview } = require("../services/hostCalendar");

module.exports.show = async (req, res) => {
  const month =
    typeof req.query.month === "string" ? req.query.month : undefined;
  const calendar = await monthOverview({}, req.user._id, month);
  res.render("host/overview-calendar.ejs", {
    calendar,
    pageTitle: "Booking calendar",
    pageDescription: "All your listings in one month.",
  });
};
