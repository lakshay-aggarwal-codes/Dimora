// "My listings" (P04-T06): one row per listing a host owns, with its state, how
// far along the readiness checklist it is, when it last changed, and the
// actions that make sense for that state. The rows are plain data so the page
// stays simple and the rules are easy to test.
const { evaluateReadiness } = require("./readiness");
const { galleryOf } = require("./images");

const MAX_ROWS = 100;

const STATUS = Object.freeze({
  draft: { label: "Draft", variant: "warning" },
  published: { label: "Published", variant: "success" },
  unpublished: { label: "Unpublished", variant: "neutral" },
  suspended: { label: "Suspended", variant: "danger" },
});

const dayFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata", // ADR-008
});

/** "17 Oct 2026" for a Date; "" for anything that is not a valid Date. */
function formatDay(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? dayFormat.format(date)
    : "";
}

/**
 * What the host can do from the list.
 * Each action is { kind: "link" | "post", label, href, primary? }; a "post" is
 * rendered as a small form with a CSRF token.
 */
function actionsFor({ id, status, canPublish }) {
  const base = `/host/listings/${id}`;
  const statusLink = { kind: "link", label: "Status and checklist", href: `${base}/status` };
  switch (status) {
    case "draft":
      return [{ kind: "link", label: "Continue", href: base, primary: true }, statusLink];
    case "published":
      return [
        { kind: "link", label: "View", href: `/listings/${id}`, primary: true },
        { kind: "link", label: "Edit", href: `/listings/${id}/edit` },
        statusLink,
        { kind: "post", label: "Unpublish", href: `${base}/unpublish` },
      ];
    case "unpublished":
      return [
        { kind: "link", label: "Edit", href: `/listings/${id}/edit`, primary: !canPublish },
        statusLink,
        ...(canPublish
          ? [{ kind: "post", label: "Publish", href: `${base}/publish`, primary: true }]
          : []),
      ];
    default: // suspended, or a state added later: nothing to change from here
      return [statusLink];
  }
}

/** One row of the table from a listing (document or plain object). */
function toRow(listing) {
  const status = Object.hasOwn(STATUS, listing.status) ? listing.status : "draft";
  const readiness = evaluateReadiness(listing);
  const id = String(listing._id);
  const cover = galleryOf(listing)[0];
  const where = [listing.get ? listing.get("address.city") : listing.address?.city, listing.country]
    .filter(Boolean)
    .join(", ");
  const updatedAt = listing.updatedAt instanceof Date ? listing.updatedAt : null;
  return {
    id,
    title: listing.title || "Untitled listing",
    where,
    coverUrl: cover ? cover.url : null,
    status,
    statusLabel: STATUS[status].label,
    statusVariant: STATUS[status].variant,
    score: readiness.score,
    canPublish: readiness.canPublish,
    missing: readiness.checks.filter((check) => !check.passed).length,
    updatedIso: updatedAt ? updatedAt.toISOString() : "",
    updatedLabel: formatDay(updatedAt),
    actions: actionsFor({ id, status, canPublish: readiness.canPublish }),
  };
}

/**
 * The host's own listings, newest change first, without deleted ones.
 * @returns {Promise<{ rows: object[], truncated: boolean }>}
 */
async function loadHostListings(Listing, ownerId, { limit = MAX_ROWS } = {}) {
  const found = await Listing.find({ owner: ownerId, deletedAt: null })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1);
  const listings = Array.isArray(found) ? found : [];
  return {
    rows: listings.slice(0, limit).map(toRow),
    truncated: listings.length > limit,
  };
}

module.exports = {
  MAX_ROWS,
  STATUS,
  formatDay,
  actionsFor,
  toRow,
  loadHostListings,
};
