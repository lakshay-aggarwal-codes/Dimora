// Publish, unpublish and delete a listing (P04-T05).
//
//   draft ──publish──▶ published ──unpublish──▶ unpublished ──publish──▶ published
//   any state ──soft delete──▶ hidden for good (the row stays: reviews and
//                              reservations remain readable by their owners)
//
// Publishing runs the Host Readiness Checklist (src/services/readiness.js);
// nothing else decides whether a listing may go public. Unpublishing and
// deleting hide the listing at once, because every public page filters on the
// status (src/utils/visibility.js).
const { evaluateReadiness } = require("./readiness");
const ledger = require("./ledger");
const { ValidationError, ConflictError } = require("../utils/errors");

/** Publishing was refused because the checklist is not complete. */
class NotReadyError extends ValidationError {
  constructor(failed) {
    super(
      `This listing is not ready to publish yet. Still to do: ${failed
        .map((check) => check.label)
        .join("; ")}.`,
      { code: "not_ready" },
    );
    this.failed = failed;
  }
}

/**
 * draft/unpublished -> published. A published listing is left as it is.
 * @returns {Promise<{ changed: boolean, readiness: object }>}
 */
async function publishListing(listing, { readiness: options } = {}) {
  if (listing.deletedAt) {
    throw new ValidationError("This listing has been deleted.");
  }
  const readiness = evaluateReadiness(listing, options);
  if (listing.status === "published") return { changed: false, readiness };
  if (!["draft", "unpublished"].includes(listing.status)) {
    throw new ValidationError("This listing cannot be published.");
  }
  if (!readiness.canPublish) {
    throw new NotReadyError(readiness.checks.filter((check) => !check.passed));
  }
  listing.status = "published";
  await listing.save();
  return { changed: true, readiness };
}

/** published -> unpublished (hidden immediately). Already hidden: no change. */
async function unpublishListing(listing) {
  if (listing.deletedAt) {
    throw new ValidationError("This listing has been deleted.");
  }
  if (listing.status === "unpublished") return { changed: false };
  if (listing.status !== "published") {
    throw new ValidationError("Only a published listing can be unpublished.");
  }
  listing.status = "unpublished";
  await listing.save();
  return { changed: true };
}

/**
 * Soft delete: hides the listing for good, keeps the row. Refused while a
 * guest still has an upcoming reservation (the night ledger knows).
 */
async function softDeleteListing(
  listing,
  { now = new Date(), ledgerService = ledger } = {},
) {
  if (listing.deletedAt) return { changed: false };
  const upcoming = await ledgerService.hasUpcomingReservation(listing._id, {
    now,
    timeZone: listing.timezone,
  });
  if (upcoming) {
    throw new ConflictError(
      "This listing has upcoming reservations, so it cannot be deleted. Unpublish it instead, or cancel the reservations first.",
    );
  }
  listing.deletedAt = now;
  if (listing.status === "published") listing.status = "unpublished";
  await listing.save();
  return { changed: true };
}

module.exports = {
  NotReadyError,
  publishListing,
  unpublishListing,
  softDeleteListing,
};
