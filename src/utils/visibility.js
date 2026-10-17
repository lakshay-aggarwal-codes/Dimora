// Who may see a listing page (P04-T05). A soft-deleted listing is gone for
// everyone; a draft or unpublished one is visible to its host and to admins;
// a published one to everybody. Public queries use `publicListingFilter`.

/** Mongo filter for the public pages: published and not soft-deleted. */
function publicListingFilter() {
  return { status: "published", deletedAt: null };
}

/** Published and not deleted (one document in memory). */
function isPublic(listing) {
  return (
    Boolean(listing) && listing.status === "published" && !listing.deletedAt
  );
}

module.exports = { publicListingFilter, isPublic };
