// Public profile data (P02-T03). What leaves this file is safe to show to
// anybody: the user is read with an explicit field list that leaves out the
// email, password hash, salt, role and status, so a template cannot print what
// it was never given.
const mongoose = require("mongoose");
const { publicListingFilter } = require("../utils/visibility");

const PUBLIC_FIELDS =
  "username displayName avatar bio createdAt hostCancellationCount";
const RECENT_REVIEWS = 5;
const EXCERPT = 200;

const monthYear = new Intl.DateTimeFormat("en-IN", {
  month: "long",
  year: "numeric",
  timeZone: "Asia/Kolkata", // ADR-008
});

/** "October 2026" for a Date; "" for anything else. */
function formatMonthYear(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? monthYear.format(date)
    : "";
}

function excerpt(text) {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > EXCERPT ? `${clean.slice(0, EXCERPT - 1)}…` : clean;
}

/**
 * @returns {Promise<object|null>} null when there is no such active user. The
 * same answer is given for a malformed id, an unknown id, a suspended account
 * and a deleted one, so a profile URL does not reveal which accounts exist.
 */
async function loadPublicProfile({ User, Listing, Review }, id) {
  if (typeof id !== "string" || !mongoose.isValidObjectId(id)) return null;
  const user = await User.findOne({ _id: id, status: "active" })
    .select(PUBLIC_FIELDS)
    .lean();
  if (!user) return null;

  const [listingCount, reviewCount, recent] = await Promise.all([
    Listing.countDocuments({ owner: user._id, ...publicListingFilter() }),
    Review.countDocuments({ author: user._id, status: { $ne: "hidden" } }),
    Review.find({ author: user._id, status: { $ne: "hidden" } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECENT_REVIEWS * 3) // some may be on listings that are not public
      .select("rating comment createdAt")
      .lean(),
  ]);

  // A review is shown only with a listing a visitor could open.
  const listings = recent.length
    ? await Listing.find({
        reviews: { $in: recent.map((review) => review._id) },
        ...publicListingFilter(),
      })
        .select("title reviews")
        .lean()
    : [];
  const listingOf = new Map();
  for (const listing of listings) {
    for (const reviewId of listing.reviews || []) {
      listingOf.set(String(reviewId), listing);
    }
  }
  const reviews = recent
    .filter((review) => listingOf.has(String(review._id)))
    .slice(0, RECENT_REVIEWS)
    .map((review) => {
      const listing = listingOf.get(String(review._id));
      return {
        rating: review.rating,
        excerpt: excerpt(review.comment),
        listingId: String(listing._id),
        listingTitle: listing.title,
      };
    });

  return {
    id: String(user._id),
    displayName: user.displayName || user.username,
    username: user.username,
    avatarUrl: user.avatar && user.avatar.url ? user.avatar.url : null,
    bio: user.bio || "",
    memberSince: formatMonthYear(user.createdAt),
    listingCount,
    reviewCount,
    // Confirmed bookings this person cancelled as a host (P09-T03).
    hostCancellationCount: Number.isSafeInteger(user.hostCancellationCount)
      ? user.hostCancellationCount
      : 0,
    reviews,
  };
}

module.exports = { loadPublicProfile, formatMonthYear, excerpt, PUBLIC_FIELDS };
