// /admin pages: the landing page, the read-only audit log (P14-T01) and user
// management (P14-T02). Listings, reports and reservations arrive with
// P14-T03..T05.
const mongoose = require("mongoose");
const audit = require("../services/audit");
const userAdmin = require("../services/userAdmin");
const { AdminRefusal } = require("../middleware/admin");
const { NotFoundError } = require("../utils/errors");

// A query value is only used when it is a plain string (?q=a&q=b is ignored).
const text = (value) => (typeof value === "string" ? value : undefined);

module.exports.index = (req, res) => {
  res.render("admin/index", { pageTitle: "Admin" });
};

module.exports.auditLog = async (req, res) => {
  const log = await audit.listAudit({ page: text(req.query.page) });
  res.render("admin/audit", { pageTitle: "Audit log", log });
};

module.exports.users = async (req, res) => {
  const result = await userAdmin.searchUsers({
    q: text(req.query.q),
    status: text(req.query.status),
    page: text(req.query.page),
  });
  res.render("admin/users", { pageTitle: "Users", result });
};

module.exports.user = async (req, res) => {
  const summary = await userAdmin.getUserSummary(req.params.id);
  if (!summary) throw new NotFoundError("That account does not exist.");
  res.render("admin/user", {
    pageTitle: summary.user.username,
    summary,
    isSelf: String(summary.user._id) === String(req.user._id),
  });
};

// Where to go back to when the action is refused.
function backTo(id) {
  return mongoose.isValidObjectId(id) ? `/admin/users/${id}` : "/admin/users";
}

// Turns a refusal from the service (nothing was changed) into AdminRefusal, so
// the wrapper shows it and writes no audit row.
async function refusing(id, work) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof userAdmin.UserAdminError) {
      throw new AdminRefusal(err.message, backTo(id));
    }
    throw err;
  }
}

// Both handlers are wrapped in auditedMutation by src/routes/admin.js.
module.exports.suspendUser = async (req) => {
  const { id } = req.params;
  const done = await refusing(id, () =>
    userAdmin.suspendUser({
      admin: req.user,
      id,
      reason: text(req.body && req.body.reason),
      store: req.sessionStore,
    }),
  );
  return {
    audit: {
      action: "user.suspend",
      targetType: "user",
      targetId: done.user._id,
      reason: done.reason,
      details: done.details,
    },
    redirectTo: backTo(id),
    flash: `"${done.user.username}" is suspended.`,
  };
};

module.exports.reinstateUser = async (req) => {
  const { id } = req.params;
  const done = await refusing(id, () =>
    userAdmin.reinstateUser({ id, reason: text(req.body && req.body.reason) }),
  );
  return {
    audit: {
      action: "user.reinstate",
      targetType: "user",
      targetId: done.user._id,
      reason: done.reason,
      details: done.details,
    },
    redirectTo: backTo(id),
    flash: `"${done.user.username}" is active again.`,
  };
};
