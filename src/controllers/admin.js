// /admin pages: the landing page, the read-only audit log (P14-T01), user
// management (P14-T02), listing moderation (P14-T03), the reports queue with
// review moderation (P14-T04), and the platform summary, read-only reservation
// lookup and audit filters (P14-T05).
const mongoose = require("mongoose");
const audit = require("../services/audit");
const AuditLog = require("../models/auditLog");
const userAdmin = require("../services/userAdmin");
const moderation = require("../services/listingModeration");
const reportQueue = require("../services/reportModeration");
const reviewModeration = require("../services/reviewModeration");
const adminSummary = require("../services/adminSummary");
const reservationAdmin = require("../services/reservationAdmin");
const { AdminRefusal } = require("../middleware/admin");
const { NotFoundError } = require("../utils/errors");

// A query value is only used when it is a plain string (?q=a&q=b is ignored).
const text = (value) => (typeof value === "string" ? value : undefined);

module.exports.index = async (req, res) => {
  const summary = await adminSummary.platformSummary();
  res.render("admin/index", { pageTitle: "Admin", summary });
};

module.exports.auditLog = async (req, res) => {
  const log = await audit.listAudit({
    page: text(req.query.page),
    action: text(req.query.action),
    actor: text(req.query.actor),
    targetType: text(req.query.targetType),
    from: text(req.query.from),
    to: text(req.query.to),
  });
  res.render("admin/audit", { pageTitle: "Audit log", log, targetTypes: AuditLog.TARGET_TYPES });
};

// ---- Reservation lookup (P14-T05): read-only ----

module.exports.reservations = async (req, res) => {
  const result = await reservationAdmin.searchReservations({
    q: text(req.query.q),
    status: text(req.query.status),
    page: text(req.query.page),
  });
  res.render("admin/reservations", { pageTitle: "Reservations", result });
};

module.exports.reservation = async (req, res) => {
  const reservation = await reservationAdmin.getReservation(req.params.id);
  if (!reservation) throw new NotFoundError("That reservation does not exist.");
  res.render("admin/reservation", { pageTitle: "Reservation", reservation });
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

// ---- Listing moderation (P14-T03) ----

module.exports.listings = async (req, res) => {
  const result = await moderation.listQueue({
    filter: text(req.query.filter),
    page: text(req.query.page),
  });
  res.render("admin/listings", { pageTitle: "Listing moderation", result });
};

module.exports.listing = async (req, res) => {
  const page = await moderation.getListingForModeration(req.params.id);
  if (!page) throw new NotFoundError("That listing does not exist.");
  res.render("admin/listing", { pageTitle: page.summary.title, page });
};

function listingBack(id) {
  return mongoose.isValidObjectId(id) ? `/admin/listings/${id}` : "/admin/listings";
}

// A refusal from the moderation service (nothing was changed) becomes
// AdminRefusal: the wrapper shows it and writes no audit row.
async function refusingListing(id, work) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof moderation.ModerationError) {
      throw new AdminRefusal(err.message, listingBack(id));
    }
    throw err;
  }
}

// The three handlers below are wrapped in auditedMutation by src/routes/admin.js.
module.exports.suspendListing = async (req) => {
  const { id } = req.params;
  const done = await refusingListing(id, () =>
    moderation.suspendListing({ admin: req.user, id, reason: text(req.body && req.body.reason) }),
  );
  return {
    audit: { action: "listing.suspend", targetType: "listing", targetId: done.listing._id, reason: done.reason, details: done.details },
    redirectTo: listingBack(id),
    flash: `"${done.listing.title}" is suspended. The host can read the reason on the listing's status page.`,
  };
};

module.exports.restoreListing = async (req) => {
  const { id } = req.params;
  const done = await refusingListing(id, () =>
    moderation.restoreListing({ admin: req.user, id, reason: text(req.body && req.body.reason) }),
  );
  return {
    audit: { action: "listing.restore", targetType: "listing", targetId: done.listing._id, reason: done.reason, details: done.details },
    redirectTo: listingBack(id),
    flash: `"${done.listing.title}" is published again.`,
  };
};

module.exports.reviewListing = async (req) => {
  const { id } = req.params;
  const done = await refusingListing(id, () =>
    moderation.markReviewed({ admin: req.user, id, note: text(req.body && req.body.note) }),
  );
  return {
    audit: { action: "listing.review", targetType: "listing", targetId: done.listing._id, reason: done.reason || undefined, details: done.details },
    redirectTo: listingBack(id),
    flash: `"${done.listing.title}" is marked as reviewed.`,
  };
};

// ---- Reports queue and review moderation (P14-T04) ----

module.exports.reports = async (req, res) => {
  const result = await reportQueue.listReports({
    status: text(req.query.status),
    kind: text(req.query.kind),
    page: text(req.query.page),
  });
  res.render("admin/reports", { pageTitle: "Reports", result });
};

module.exports.report = async (req, res) => {
  const page = await reportQueue.getReport(req.params.id);
  if (!page) throw new NotFoundError("That report does not exist.");
  res.render("admin/report", { pageTitle: `Report ${page.report.id.slice(-6)}`, page });
};

function reportBack(id) {
  return mongoose.isValidObjectId(id) ? `/admin/reports/${id}` : "/admin/reports";
}

async function refusingReport(back, work) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof reportQueue.ReportAdminError || err instanceof reviewModeration.ReviewModerationError) {
      throw new AdminRefusal(err.message, back);
    }
    throw err;
  }
}

function closeWith(outcome, verb) {
  return async (req) => {
    const { id } = req.params;
    const done = await refusingReport(reportBack(id), () =>
      reportQueue.closeReport({
        admin: req.user,
        id,
        outcome,
        note: text(req.body && req.body.note),
        closeOthers: Boolean(req.body && req.body.closeOthers === "1"),
      }),
    );
    return {
      audit: { action: `report.${outcome}`, targetType: "report", targetId: done.report._id, reason: done.note, details: done.details },
      redirectTo: "/admin/reports",
      flash: done.closedOthers > 0 ? `Report ${verb}, with ${done.closedOthers} other open report${done.closedOthers === 1 ? "" : "s"} about the same thing.` : `Report ${verb}.`,
    };
  };
}

// Wrapped in auditedMutation by src/routes/admin.js.
module.exports.resolveReport = closeWith("resolve", "resolved");
module.exports.dismissReport = closeWith("dismiss", "dismissed");

// `from` is the report page the moderator came from (a valid id only).
const backFrom = (req) => (req.body && typeof req.body.from === "string" ? reportBack(req.body.from) : "/admin/reports");

module.exports.hideReview = async (req) => {
  const { id } = req.params;
  const done = await refusingReport(backFrom(req), () =>
    reviewModeration.hideReview({ admin: req.user, id, reason: text(req.body && req.body.reason) }),
  );
  return {
    audit: { action: "review.hide", targetType: "review", targetId: done.review._id, reason: done.reason, details: done.details },
    redirectTo: backFrom(req),
    flash: "The review is hidden and no longer counts in the listing's rating.",
  };
};

module.exports.restoreReview = async (req) => {
  const { id } = req.params;
  const done = await refusingReport(backFrom(req), () =>
    reviewModeration.restoreReview({ admin: req.user, id, reason: text(req.body && req.body.reason) }),
  );
  return {
    audit: { action: "review.restore", targetType: "review", targetId: done.review._id, reason: done.reason, details: done.details },
    redirectTo: backFrom(req),
    flash: "The review is visible again and counts in the listing's rating.",
  };
};
