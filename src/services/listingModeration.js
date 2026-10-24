// Listing moderation for admins (P14-T03): the queue (reported, new, suspended),
// one listing's moderation page, and suspend / restore / mark reviewed. The
// routes (src/routes/admin.js) call these inside auditedMutation, which writes
// the audit row; nothing here writes one.
//
// - Suspend: only a published, not-deleted listing. It becomes `suspended` (so
//   every public page, search and booking check stops seeing it), the reason is
//   kept on the listing for the host to read, and the listing counts as
//   reviewed. Done with one conditional update, so two admins at once cannot
//   both succeed. Bookings already made are left alone (see docs).
// - Restore: only a listing suspended by moderation, never one hidden because
//   its host's account is suspended (that comes back when the host is
//   reinstated, P14-T02). It becomes `published` again and counts as reviewed.
// - Mark reviewed: takes a published listing out of the "new" queue.
// Reports (P12-T04) about a listing are shown but not closed here: that is
// P14-T04.
const mongoose = require("mongoose");
const Listing = require("../models/listing");
const Report = require("../models/report");
const AuditLog = require("../models/auditLog");
const { toPageNumber } = require("./audit");
const { REPORT_REASONS } = require("../config/reports");

const PAGE_SIZE = 20;
const REASON_MIN = 5;
const REASON_MAX = 500;
const FILTERS = Object.freeze(["reported", "new", "suspended"]);
const LIST_FIELDS =
  "title status address.city address.state country owner createdAt updatedAt hiddenByOwnerSuspension moderation deletedAt";
const reasonLabel = Object.fromEntries(
  REPORT_REASONS.map((r) => [r.value, r.label]),
);

class ModerationError extends Error {
  /** @param {string} message user-safe text, shown to the admin */
  constructor(message) {
    super(message);
    this.name = "ModerationError";
  }
}

const isId = (value) =>
  typeof value === "string" && mongoose.isValidObjectId(value);

/** The trimmed reason, or a ModerationError when it is missing/too short/long. */
function cleanReason(value, { required = true } = {}) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason && !required) return "";
  if (reason.length < REASON_MIN) {
    throw new ModerationError(
      `Give a reason (at least ${REASON_MIN} characters). It is written to the audit log${required ? " and shown to the host" : ""}.`,
    );
  }
  if (reason.length > REASON_MAX) {
    throw new ModerationError(
      `The reason must be ${REASON_MAX} characters or fewer.`,
    );
  }
  return reason;
}

// Open reports per listing id: Map(idString -> count).
async function openReportCounts(ids) {
  if (!ids.length) return new Map();
  const rows = await Report.aggregate([
    {
      $match: { targetKind: "listing", status: "open", targetId: { $in: ids } },
    },
    { $group: { _id: "$targetId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

function toRow(listing, reports) {
  return {
    id: String(listing._id),
    title: listing.title,
    status: listing.status,
    place: [listing.address && listing.address.city, listing.country]
      .filter(Boolean)
      .join(", "),
    host: listing.owner && listing.owner.username ? listing.owner.username : "",
    hostId: listing.owner && listing.owner._id ? String(listing.owner._id) : "",
    createdAt: listing.createdAt,
    openReports: reports.get(String(listing._id)) || 0,
    // Hidden because the HOST's account is suspended: restored by reinstating the host.
    hiddenWithHost: Boolean(listing.hiddenByOwnerSuspension),
    reviewed: Boolean(listing.moderation && listing.moderation.reviewedAt),
  };
}

/**
 * One page of a queue.
 *   reported   listings with open reports, most reports first
 *   new        published listings no admin has reviewed yet, oldest first
 *   suspended  suspended listings, latest first
 * @returns {{ rows: object[], page: number, totalPages: number, total: number, filter: string }}
 */
async function listQueue({ filter, page } = {}) {
  const which =
    typeof filter === "string" && FILTERS.includes(filter)
      ? filter
      : "reported";
  const requested = toPageNumber(page);

  let total;
  let listings;
  if (which === "reported") {
    const grouped = await Report.aggregate([
      { $match: { targetKind: "listing", status: "open" } },
      {
        $group: {
          _id: "$targetId",
          count: { $sum: 1 },
          latest: { $max: "$createdAt" },
        },
      },
    ]);
    // Only listings that still exist, most reported first, then most recent.
    const existing = await Listing.find({
      _id: { $in: grouped.map((g) => g._id) },
      deletedAt: null,
    })
      .select("_id")
      .lean();
    const alive = new Set(existing.map((l) => String(l._id)));
    const ordered = grouped
      .filter((g) => alive.has(String(g._id)))
      .sort(
        (a, b) =>
          b.count - a.count ||
          b.latest - a.latest ||
          String(a._id).localeCompare(String(b._id)),
      );
    total = ordered.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(requested, totalPages);
    const ids = ordered
      .slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
      .map((g) => g._id);
    const found = await Listing.find({ _id: { $in: ids } })
      .select(LIST_FIELDS)
      .populate("owner", "username")
      .lean();
    const byId = new Map(found.map((l) => [String(l._id), l]));
    listings = ids.map((id) => byId.get(String(id))).filter(Boolean);
    const counts = new Map(grouped.map((g) => [String(g._id), g.count]));
    return {
      rows: listings.map((l) => toRow(l, counts)),
      page: current,
      totalPages,
      total,
      filter: which,
    };
  }

  const query =
    which === "new"
      ? { status: "published", deletedAt: null, "moderation.reviewedAt": null }
      : { status: "suspended", deletedAt: null };
  const sort =
    which === "new" ? { createdAt: 1, _id: 1 } : { updatedAt: -1, _id: -1 };
  total = await Listing.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(requested, totalPages);
  listings = await Listing.find(query)
    .select(LIST_FIELDS)
    .populate("owner", "username")
    .sort(sort)
    .skip((current - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();
  const counts = await openReportCounts(listings.map((l) => l._id));
  return {
    rows: listings.map((l) => toRow(l, counts)),
    page: current,
    totalPages,
    total,
    filter: which,
  };
}

/**
 * The moderation page of one listing, or null for a malformed/unknown id (a
 * deleted listing can still be looked at). Never includes the host's email.
 */
async function getListingForModeration(id) {
  if (!isId(id)) return null;
  const listing = await Listing.findById(id)
    .select(`${LIST_FIELDS} description pricing images image status`)
    .populate("owner", "username displayName status")
    .populate("moderation.suspendedBy", "username")
    .lean();
  if (!listing) return null;

  const [reports, history] = await Promise.all([
    Report.find({
      targetKind: "listing",
      targetId: listing._id,
      status: "open",
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(20)
      .populate("reporter", "username")
      .select("reporter reason details createdAt")
      .lean(),
    AuditLog.find({ targetType: "listing", targetId: listing._id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(10)
      .populate("actor", "username")
      .lean(),
  ]);
  const photos = Array.isArray(listing.images)
    ? listing.images.length
    : listing.image && listing.image.url
      ? 1
      : 0;
  const desc =
    typeof listing.description === "string" ? listing.description.trim() : "";
  return {
    listing,
    summary: {
      id: String(listing._id),
      title: listing.title,
      status: listing.status,
      deleted: Boolean(listing.deletedAt),
      place: [
        listing.address && listing.address.city,
        listing.address && listing.address.state,
        listing.country,
      ]
        .filter(Boolean)
        .join(", "),
      nightlyMinor:
        listing.pricing && Number.isSafeInteger(listing.pricing.nightlyMinor)
          ? listing.pricing.nightlyMinor
          : null,
      currency: (listing.pricing && listing.pricing.currency) || "INR",
      photos,
      descriptionExcerpt: desc.length > 400 ? `${desc.slice(0, 400)}…` : desc,
      hiddenWithHost: Boolean(listing.hiddenByOwnerSuspension),
      reviewedAt:
        listing.moderation && listing.moderation.reviewedAt
          ? listing.moderation.reviewedAt
          : null,
      suspendedAt:
        listing.moderation && listing.moderation.suspendedAt
          ? listing.moderation.suspendedAt
          : null,
      suspendedBy:
        listing.moderation && listing.moderation.suspendedBy
          ? listing.moderation.suspendedBy.username
          : "",
      suspendReason:
        (listing.moderation && listing.moderation.suspendReason) || "",
      host: listing.owner
        ? {
            id: String(listing.owner._id),
            username: listing.owner.username,
            status: listing.owner.status || "active",
          }
        : null,
    },
    reports: reports.map((r) => ({
      reporter: r.reporter ? r.reporter.username : "(deleted account)",
      reason: reasonLabel[r.reason] || r.reason,
      details: r.details || "",
      createdAt: r.createdAt,
    })),
    history,
  };
}

/**
 * @returns {Promise<{ listing: object, reason: string, details: object }>}
 * @throws {ModerationError} nothing was changed
 */
async function suspendListing({ admin, id, reason, now = new Date() }) {
  const text = cleanReason(reason);
  if (!isId(id)) throw new ModerationError("That listing does not exist.");
  const listing = await Listing.findById(id)
    .select("title status deletedAt owner")
    .lean();
  if (!listing) throw new ModerationError("That listing does not exist.");
  if (listing.deletedAt)
    throw new ModerationError("That listing was deleted by its host.");
  if (listing.status !== "published") {
    throw new ModerationError(
      listing.status === "suspended"
        ? "That listing is already suspended."
        : "Only a published listing can be suspended: drafts and unpublished listings are not visible to guests anyway.",
    );
  }
  const result = await Listing.updateOne(
    { _id: listing._id, status: "published", deletedAt: null },
    {
      $set: {
        status: "suspended",
        "moderation.suspendedAt": now,
        "moderation.suspendedBy": admin._id,
        "moderation.suspendReason": text,
        "moderation.reviewedAt": now,
        "moderation.reviewedBy": admin._id,
      },
      $unset: { hiddenByOwnerSuspension: "" },
    },
  );
  if (!result || result.modifiedCount !== 1) {
    throw new ModerationError(
      "That listing changed while you were suspending it. Reload the page and try again.",
    );
  }
  return {
    listing,
    reason: text,
    details: {
      title: listing.title,
      from: "published",
      to: "suspended",
      host: String(listing.owner || ""),
    },
  };
}

/** @throws {ModerationError} nothing was changed */
async function restoreListing({ admin, id, reason, now = new Date() }) {
  const text = cleanReason(reason);
  if (!isId(id)) throw new ModerationError("That listing does not exist.");
  const listing = await Listing.findById(id)
    .select("title status deletedAt owner hiddenByOwnerSuspension")
    .lean();
  if (!listing) throw new ModerationError("That listing does not exist.");
  if (listing.deletedAt)
    throw new ModerationError("That listing was deleted by its host.");
  if (listing.status !== "suspended")
    throw new ModerationError("That listing is not suspended.");
  if (listing.hiddenByOwnerSuspension) {
    throw new ModerationError(
      "This listing is hidden because its host's account is suspended. Reinstate the account to publish it again.",
    );
  }
  const result = await Listing.updateOne(
    {
      _id: listing._id,
      status: "suspended",
      deletedAt: null,
      hiddenByOwnerSuspension: { $ne: true },
    },
    {
      $set: {
        status: "published",
        "moderation.reviewedAt": now,
        "moderation.reviewedBy": admin._id,
      },
      $unset: {
        "moderation.suspendedAt": "",
        "moderation.suspendedBy": "",
        "moderation.suspendReason": "",
      },
    },
  );
  if (!result || result.modifiedCount !== 1) {
    throw new ModerationError(
      "That listing changed while you were restoring it. Reload the page and try again.",
    );
  }
  return {
    listing,
    reason: text,
    details: {
      title: listing.title,
      from: "suspended",
      to: "published",
      host: String(listing.owner || ""),
    },
  };
}

/** Takes a published listing out of the "new" queue. The note is optional. */
async function markReviewed({ admin, id, note, now = new Date() }) {
  const text = cleanReason(note, { required: false });
  if (!isId(id)) throw new ModerationError("That listing does not exist.");
  const listing = await Listing.findById(id)
    .select("title status deletedAt moderation.reviewedAt")
    .lean();
  if (!listing) throw new ModerationError("That listing does not exist.");
  if (listing.deletedAt)
    throw new ModerationError("That listing was deleted by its host.");
  if (listing.moderation && listing.moderation.reviewedAt)
    throw new ModerationError("That listing is already marked as reviewed.");
  const result = await Listing.updateOne(
    { _id: listing._id, deletedAt: null, "moderation.reviewedAt": null },
    {
      $set: {
        "moderation.reviewedAt": now,
        "moderation.reviewedBy": admin._id,
      },
    },
  );
  if (!result || result.modifiedCount !== 1) {
    throw new ModerationError(
      "That listing changed in the meantime. Reload the page and try again.",
    );
  }
  return {
    listing,
    reason: text,
    details: { title: listing.title, status: listing.status },
  };
}

module.exports = {
  ModerationError,
  listQueue,
  getListingForModeration,
  suspendListing,
  restoreListing,
  markReviewed,
  cleanReason,
  FILTERS,
  PAGE_SIZE,
};
