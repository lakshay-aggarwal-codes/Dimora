// The moderators' reports queue (P14-T04): list, open one, close it as
// resolved or dismissed. The routes (src/routes/admin.js) call closeReport
// inside auditedMutation, which writes the audit row; nothing here writes one.
//
// - A report is only ever closed, never deleted. Closing is a compare-and-set
//   on `status: "open"`, so two admins cannot both close it.
// - "Resolved" means action was taken (or is no longer needed), "dismissed"
//   means nothing needed action. Both need a short note; the reporter reads the
//   outcome on their "My reports" page, never the note or who closed it.
// - Closing can also close the other OPEN reports about the same target in one
//   step, so one decision does not need five clicks.
// - Reports about messages cannot be opened yet: messaging (P11) does not
//   exist. When it does, a message report may show only the reported
//   conversation, never the inbox (docs/tasks/P14-T04.md).
const mongoose = require("mongoose");
const { toPageNumber } = require("./audit");
const {
  REPORT_KINDS,
  REPORT_REASONS,
  REPORT_STATUSES,
} = require("../config/reports");

const PAGE_SIZE = 20;
const NOTE_MIN = 5;
const NOTE_MAX = 500;
const STATUS_FILTERS = Object.freeze(["open", "resolved", "dismissed"]);
const KIND_VALUES = REPORT_KINDS.map((k) => k.value);
const kindLabel = Object.fromEntries(
  REPORT_KINDS.map((k) => [k.value, k.label]),
);
const reasonLabel = Object.fromEntries(
  REPORT_REASONS.map((r) => [r.value, r.label]),
);
const OUTCOMES = Object.freeze({ resolve: "resolved", dismiss: "dismissed" });

class ReportAdminError extends Error {
  /** @param {string} message user-safe text, shown to the admin */
  constructor(message) {
    super(message);
    this.name = "ReportAdminError";
  }
}

const isId = (value) =>
  typeof value === "string" && mongoose.isValidObjectId(value);

function models(over = {}) {
  return {
    ReportModel: over.ReportModel || require("../models/report"),
    ReviewModel: over.ReviewModel || require("../models/review"),
    ListingModel: over.ListingModel || require("../models/listing"),
    UserModel: over.UserModel || require("../models/user"),
  };
}

function cleanNote(value) {
  const note = typeof value === "string" ? value.trim() : "";
  if (note.length < NOTE_MIN) {
    throw new ReportAdminError(
      `Write a short note (at least ${NOTE_MIN} characters). It is written to the audit log.`,
    );
  }
  if (note.length > NOTE_MAX)
    throw new ReportAdminError(
      `The note must be ${NOTE_MAX} characters or fewer.`,
    );
  return note;
}

function toRow(report, openOnTarget) {
  return {
    id: String(report._id),
    kind: report.targetKind,
    kindLabel: kindLabel[report.targetKind] || "Item",
    target: report.targetLabel || "Removed item",
    reasonLabel: reasonLabel[report.reason] || "Other",
    reporter:
      report.reporter && report.reporter.username
        ? report.reporter.username
        : "(removed account)",
    status: report.status,
    createdAt: report.createdAt,
    resolvedAt: report.resolvedAt || null,
    openOnTarget: openOnTarget || 0,
  };
}

/**
 * One page of the queue. Open reports are oldest first (nobody waits longest
 * for nothing); closed ones are newest first.
 * @returns {{ rows: object[], page: number, totalPages: number, total: number, status: string, kind: string, counts: object }}
 */
async function listReports({ status, kind, page, ...over } = {}) {
  const { ReportModel } = models(over);
  const which =
    typeof status === "string" && STATUS_FILTERS.includes(status)
      ? status
      : "open";
  const filter = { status: which };
  const kindWanted =
    typeof kind === "string" && KIND_VALUES.includes(kind) ? kind : "";
  if (kindWanted) filter.targetKind = kindWanted;

  const [total, openTotal] = await Promise.all([
    ReportModel.countDocuments(filter),
    ReportModel.countDocuments({ status: "open" }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(toPageNumber(page), totalPages);
  const rows = await ReportModel.find(filter)
    .sort(
      which === "open" ? { createdAt: 1, _id: 1 } : { resolvedAt: -1, _id: -1 },
    )
    .skip((current - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .populate("reporter", "username")
    .lean();

  // How many open reports each row's target has (one grouped query).
  const open = new Map();
  if (rows.length > 0) {
    const grouped = await ReportModel.aggregate([
      {
        $match: {
          status: "open",
          targetId: { $in: rows.map((r) => r.targetId) },
        },
      },
      {
        $group: {
          _id: { kind: "$targetKind", id: "$targetId" },
          count: { $sum: 1 },
        },
      },
    ]);
    for (const g of grouped) open.set(`${g._id.kind}|${g._id.id}`, g.count);
  }
  return {
    rows: rows.map((r) => toRow(r, open.get(`${r.targetKind}|${r.targetId}`))),
    page: current,
    totalPages,
    total,
    status: which,
    kind: kindWanted,
    openTotal,
  };
}

/** What the moderator needs to see about the reported thing. */
async function describeReported(
  report,
  { ListingModel, ReviewModel, UserModel },
) {
  const id = report.targetId;
  if (report.targetKind === "listing") {
    const listing = await ListingModel.findById(id)
      .select("title status deletedAt owner")
      .lean();
    if (!listing) return { kind: "listing", gone: true };
    return {
      kind: "listing",
      title: listing.title,
      status: listing.deletedAt ? "deleted" : listing.status,
      url: `/admin/listings/${id}`,
    };
  }
  if (report.targetKind === "review") {
    const review = await ReviewModel.findById(id)
      .populate("author", "username")
      .lean();
    if (!review) return { kind: "review", gone: true };
    const listing = review.listing
      ? await ListingModel.findById(review.listing).select("title").lean()
      : await ListingModel.findOne({ reviews: review._id })
          .select("title")
          .lean();
    return {
      kind: "review",
      id: String(review._id),
      rating: review.rating,
      comment: review.comment || "",
      author:
        review.author && review.author.username
          ? review.author.username
          : "(removed account)",
      authorId:
        review.author && review.author._id ? String(review.author._id) : null,
      listingTitle: listing ? listing.title : "(a listing that is gone)",
      hidden: review.status === "hidden",
      hiddenReason:
        review.moderation && review.moderation.hiddenReason
          ? review.moderation.hiddenReason
          : "",
      createdAt: review.createdAt || null,
    };
  }
  if (report.targetKind === "user") {
    const user = await UserModel.findById(id).select("username status").lean();
    if (!user) return { kind: "user", gone: true };
    return {
      kind: "user",
      username: user.username,
      status: user.status,
      url: `/admin/users/${id}`,
    };
  }
  // A message: messaging does not exist yet, so there is no thread to show.
  return { kind: "message", unavailable: true };
}

/** One report with the reported thing and the other reports about it, or null. */
async function getReport(id, over = {}) {
  if (!isId(id)) return null;
  const m = models(over);
  const report = await m.ReportModel.findById(id)
    .populate("reporter", "username")
    .populate("resolvedBy", "username")
    .lean();
  if (!report) return null;
  const [target, others] = await Promise.all([
    describeReported(report, m),
    m.ReportModel.find({
      targetKind: report.targetKind,
      targetId: report.targetId,
      _id: { $ne: report._id },
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(20)
      .populate("reporter", "username")
      .select("reason details status createdAt reporter")
      .lean(),
  ]);
  return {
    report: {
      ...toRow(report, 0),
      details: report.details || "",
      note: report.resolutionNote || "",
      resolvedBy:
        report.resolvedBy && report.resolvedBy.username
          ? report.resolvedBy.username
          : null,
      targetKind: report.targetKind,
      targetId: String(report.targetId),
    },
    target,
    others: others.map((o) => ({
      id: String(o._id),
      reasonLabel: reasonLabel[o.reason] || "Other",
      details: o.details || "",
      status: o.status,
      reporter:
        o.reporter && o.reporter.username
          ? o.reporter.username
          : "(removed account)",
      createdAt: o.createdAt,
    })),
    openOthers: others.filter((o) => o.status === "open").length,
  };
}

/**
 * Close one open report as resolved or dismissed.
 * @param {{ admin: object, id: string, outcome: "resolve"|"dismiss", note: string, closeOthers?: boolean, now?: Date }} input
 * @returns {Promise<{ report: object, outcome: string, note: string, closedOthers: number, details: object }>}
 * @throws {ReportAdminError} nothing was changed
 */
async function closeReport({
  admin,
  id,
  outcome,
  note,
  closeOthers = false,
  now = new Date(),
  ...over
}) {
  const status = OUTCOMES[outcome];
  if (!status) throw new ReportAdminError("Choose resolve or dismiss.");
  const text = cleanNote(note);
  if (!isId(id)) throw new ReportAdminError("That report does not exist.");
  const { ReportModel } = models(over);

  const report = await ReportModel.findOneAndUpdate(
    { _id: id, status: "open" },
    {
      $set: {
        status,
        resolvedAt: now,
        resolvedBy: admin._id,
        resolutionNote: text,
      },
    },
    { new: true },
  ).lean();
  if (!report) {
    const exists = await ReportModel.exists({ _id: id });
    throw new ReportAdminError(
      exists
        ? "This report was already closed."
        : "That report does not exist.",
    );
  }

  let closedOthers = 0;
  if (closeOthers) {
    const result = await ReportModel.updateMany(
      {
        targetKind: report.targetKind,
        targetId: report.targetId,
        status: "open",
      },
      {
        $set: {
          status,
          resolvedAt: now,
          resolvedBy: admin._id,
          resolutionNote: text,
        },
      },
    );
    closedOthers = result.modifiedCount || 0;
  }
  return {
    report,
    outcome: status,
    note: text,
    closedOthers,
    details: {
      outcome: status,
      targetKind: report.targetKind,
      targetId: String(report.targetId),
      closedOthers,
    },
  };
}

module.exports = {
  listReports,
  getReport,
  closeReport,
  cleanNote,
  ReportAdminError,
  PAGE_SIZE,
  NOTE_MIN,
  NOTE_MAX,
  STATUS_FILTERS,
  REPORT_STATUSES,
};
