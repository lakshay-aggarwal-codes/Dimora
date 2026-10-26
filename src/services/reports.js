// Reports (P12-T04): sending one and listing your own.
//
//   describeTarget(deps, kind, id)   -> { kind, id, owner, label, url }   (404 when it cannot be reported)
//   createReport(deps, { user, kind, id, reason, details, now })
//   listMyReports(deps, userId)      -> rows for the "Your reports" page
//
// Rules, all enforced here and never by the form:
// - you can only report what you could open: a published listing, a review on
//   one, an active member; anything else is the same 404 as a missing id;
// - you cannot report your own listing, review or profile (policy report:create);
// - one OPEN report per person and target. The partial unique index on the
//   model decides it, so two simultaneous clicks make one report;
// - at most LIMITS.perDay reports per person in 24 hours, counted in the
//   database (the per-minute limiter on the route is per server process);
// - the reason comes from a fixed list; "something else" needs a few words;
// - details are plain text, trimmed, up to 1000 characters (longer is refused, never cut).
// Messages are not reportable until messaging exists (P11).
const mongoose = require("mongoose");
const { can } = require("../policies");
const { isPublic } = require("../utils/visibility");
const {
  REPORT_KINDS,
  REPORTABLE_KINDS,
  REPORT_REASONS,
  REASON_VALUES,
  LIMITS,
} = require("../config/reports");
const {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require("../utils/errors");

const DAY_MS = 24 * 60 * 60 * 1000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const kindLabel = Object.fromEntries(
  REPORT_KINDS.map((k) => [k.value, k.label]),
);
const reasonLabel = Object.fromEntries(
  REPORT_REASONS.map((r) => [r.value, r.label]),
);

const STATUS_TEXT = Object.freeze({
  open: { label: "Received", note: "We have your report and will look at it." },
  resolved: {
    label: "Looked at",
    note: "We looked into this and took action where it was needed.",
  },
  dismissed: {
    label: "Closed",
    note: "We looked into this and found nothing that needs action.",
  },
});

const label = (text, max = 120) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** Reason and details from a form. Returns { reason, details }; throws ValidationError. */
function parseReportInput({ reason, details }) {
  if (typeof reason !== "string" || !REASON_VALUES.includes(reason)) {
    throw new ValidationError("Choose a reason for your report.");
  }
  if (
    details !== undefined &&
    details !== null &&
    typeof details !== "string"
  ) {
    throw new ValidationError("The details must be text.");
  }
  const text = (details || "").trim();
  if (text.length > LIMITS.detailsMax) {
    throw new ValidationError(
      `The details can be at most ${LIMITS.detailsMax} characters.`,
    );
  }
  if (reason === "other" && text.length < LIMITS.otherMin) {
    throw new ValidationError(
      `Please say a little more (at least ${LIMITS.otherMin} characters) when the reason is "something else".`,
    );
  }
  return { reason, details: text };
}

/**
 * What a report is about, or a 404. `owner` is who made it; the policy uses it
 * to refuse reports about your own things.
 */
async function describeTarget(
  {
    ListingModel = require("../models/listing"),
    ReviewModel = require("../models/review"),
    UserModel = require("../models/user"),
  } = {},
  kind,
  id,
) {
  const missing = () =>
    new NotFoundError(
      "That cannot be reported: it does not exist or is no longer visible.",
    );
  if (typeof kind !== "string" || !REPORT_KINDS.some((k) => k.value === kind)) {
    throw new ValidationError("Choose what you want to report.");
  }
  if (!REPORTABLE_KINDS.includes(kind)) {
    throw new ValidationError("Messages cannot be reported yet.");
  }
  if (typeof id !== "string" || !OBJECT_ID.test(id)) throw missing();

  if (kind === "listing") {
    const listing = await ListingModel.findById(id)
      .select("title owner status deletedAt")
      .lean();
    if (!isPublic(listing)) throw missing();
    return {
      kind,
      id,
      owner: listing.owner || null,
      label: label(listing.title),
      url: `/listings/${id}`,
    };
  }
  if (kind === "review") {
    const review = await ReviewModel.findById(id).select("author listing").lean();
    if (!review) throw missing();
    // A review is shown only on its listing, so it is reportable only while that
    // listing is public. The review knows its listing (since reviews v2); only a
    // review without one is looked up by the listing's own list of reviews, which
    // has no index (P18-T02).
    const listing = review.listing
      ? await ListingModel.findById(review.listing).select("title status deletedAt").lean()
      : await ListingModel.findOne({ reviews: review._id }).select("title status deletedAt").lean();
    if (!isPublic(listing)) throw missing();
    return {
      kind,
      id,
      owner: review.author || null,
      label: label(`A review of ${listing.title}`),
      url: `/listings/${listing._id}#reviews-heading`,
    };
  }
  const member = await UserModel.findOne({ _id: id, status: "active" })
    .select("username displayName")
    .lean();
  if (!member) throw missing();
  return {
    kind,
    id,
    owner: member._id,
    label: label(member.displayName || member.username),
    url: `/users/${id}`,
  };
}

/**
 * @returns {Promise<{ report: object, created: true }>}
 * Errors: 400 bad input, 403 your own / inactive account, 404 not reportable,
 * 409 `already_reported`, 429 `report_limit`.
 */
async function createReport(
  { ReportModel = require("../models/report"), ...targets } = {},
  { user, kind, id, reason, details, now = new Date() },
) {
  const input = parseReportInput({ reason, details });
  const target = await describeTarget(targets, kind, id);
  if (!can("report:create", user, { owner: target.owner })) {
    const own =
      user && target.owner && String(target.owner) === String(user._id);
    throw new ForbiddenError(
      own
        ? `You cannot report your own ${kindLabel[kind].toLowerCase()}.`
        : "Your account cannot send reports.",
    );
  }

  const since = new Date();
  since.setTime(now.getTime() - DAY_MS);
  if (
    (await ReportModel.countDocuments({
      reporter: user._id,
      createdAt: { $gte: since },
    })) >= LIMITS.perDay
  ) {
    throw new AppError(
      429,
      "You have sent a lot of reports today. Please try again tomorrow.",
      { code: "report_limit" },
    );
  }

  const duplicate = () =>
    new ConflictError(
      "You already have an open report about this. We will look at it; there is no need to send it again.",
      {
        code: "already_reported",
      },
    );
  const same = {
    reporter: user._id,
    targetKind: kind,
    targetId: id,
    status: "open",
  };
  if (await ReportModel.exists(same)) throw duplicate();
  try {
    const report = await ReportModel.create({
      reporter: user._id,
      targetKind: kind,
      targetId: id,
      targetOwner: target.owner,
      targetLabel: target.label,
      reason: input.reason,
      details: input.details || undefined,
    });
    return { report, created: true };
  } catch (err) {
    if (err && err.code === 11000) throw duplicate(); // two clicks at once: the index decided
    throw err;
  }
}

/** The reporter's own reports, newest first (what the "Your reports" page prints). */
async function listMyReports(
  { ReportModel = require("../models/report") } = {},
  userId,
  { limit = 50 } = {},
) {
  if (!mongoose.isValidObjectId(String(userId))) return [];
  const rows = await ReportModel.find({ reporter: userId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .select("targetKind targetId targetLabel reason status createdAt")
    .lean();
  return rows.map((row) => {
    const status = STATUS_TEXT[row.status] || STATUS_TEXT.open;
    return {
      id: String(row._id),
      kind: row.targetKind,
      kindLabel: kindLabel[row.targetKind] || "Item",
      target: row.targetLabel || "Removed item",
      reasonLabel: reasonLabel[row.reason] || "Other",
      status: row.status,
      statusLabel: status.label,
      statusNote: status.note,
      createdAt: row.createdAt,
    };
  });
}

module.exports = {
  createReport,
  describeTarget,
  listMyReports,
  parseReportInput,
  STATUS_TEXT,
};
