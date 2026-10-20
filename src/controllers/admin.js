// /admin pages (P14-T01): a landing page and the read-only audit log.
// Users, listings and reports arrive with P14-T02..T05.
const audit = require("../services/audit");

module.exports.index = (req, res) => {
  res.render("admin/index", { pageTitle: "Admin" });
};

module.exports.auditLog = async (req, res) => {
  const page = typeof req.query.page === "string" ? req.query.page : undefined;
  const log = await audit.listAudit({ page });
  res.render("admin/audit", { pageTitle: "Audit log", log });
};
