// Reports (P12-T04). The form shows what is being reported (looked up by the
// server from kind + id, never taken from the page), who may send it is the
// `report:create` policy, and everything else is services/reports.js.
const { can } = require("../policies");
const { REPORT_REASONS, REPORT_KINDS, LIMITS } = require("../config/reports");
const {
  createReport,
  describeTarget,
  listMyReports,
} = require("../services/reports");
const {
  ValidationError,
  ConflictError,
  ForbiddenError,
} = require("../utils/errors");

const text = (value) => (typeof value === "string" ? value : "");

async function renderForm(
  req,
  res,
  { kind, id, values = {}, error = null, status = 200 },
) {
  const target = await describeTarget({}, kind, id);
  if (!can("report:create", req.user, { owner: target.owner })) {
    throw new ForbiddenError(
      target.owner && String(target.owner) === String(req.user._id)
        ? "You cannot report your own listing, review or profile."
        : "Your account cannot send reports.",
    );
  }
  res.status(status).render("reports/new.ejs", {
    target: {
      kind: target.kind,
      id: target.id,
      label: target.label,
      url: target.url,
    },
    kindLabel: REPORT_KINDS.find((k) => k.value === target.kind).label,
    reasons: REPORT_REASONS,
    limits: LIMITS,
    values: { reason: text(values.reason), details: text(values.details) },
    error,
    pageTitle: "Report",
  });
}

module.exports.newForm = async (req, res) => {
  await renderForm(req, res, {
    kind: text(req.query.kind),
    id: text(req.query.id),
  });
};

module.exports.create = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const kind = text(body.kind);
  const id = text(body.id);
  try {
    await createReport(
      {},
      { user: req.user, kind, id, reason: body.reason, details: body.details },
    );
  } catch (err) {
    if (err instanceof ValidationError && kind && id) {
      // Show the form again with what was typed and the reason it was refused.
      return renderForm(req, res, {
        kind,
        id,
        values: body,
        error: err.message,
        status: 400,
      });
    }
    if (err instanceof ConflictError && err.code === "already_reported") {
      req.flash("error", err.message);
      return res.redirect("/reports");
    }
    throw err;
  }
  req.flash(
    "success",
    "Thank you. Your report was received. You can follow its status here.",
  );
  return res.redirect("/reports");
};

module.exports.index = async (req, res) => {
  const reports = await listMyReports({}, req.user._id);
  res.render("reports/index.ejs", { reports, pageTitle: "Your reports" });
};
