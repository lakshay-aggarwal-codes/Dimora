// /host/report and /host/report.csv (P13-T04). Any signed-in host; the report
// only ever reads that host's own listings and stays (services/hostReport.js).
const hostReport = require("../services/hostReport");

module.exports.show = async (req, res) => {
  const report = await hostReport.buildReport({}, req.user._id, req.query);
  res.set("Cache-Control", "no-store");
  res.render("host/report.ejs", {
    report,
    pageTitle: "Earnings and occupancy",
    pageDescription: "Estimated earnings and occupancy for your listings.",
  });
};

module.exports.csv = async (req, res) => {
  const report = await hostReport.buildReport({}, req.user._id, req.query);
  const name = `dimora-report-${report.range.fromKey}-to-${report.range.toKey}.csv`;
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
  });
  res.send(hostReport.toCsv(report));
};
