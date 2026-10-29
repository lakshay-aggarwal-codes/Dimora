// /host/listings/:id/stats (P13-T03). Behind authorize("listing:edit"), so only
// the listing's host gets here and the listing is on req.listing.
const listingStats = require("../services/listingStats");
const { NotFoundError } = require("../utils/errors");

module.exports.show = async (req, res) => {
  const listing = req.listing;
  if (listing.deletedAt) throw new NotFoundError("That listing does not exist.");
  const stats = await listingStats.getStats(listing._id);
  res.set("Cache-Control", "no-store");
  res.render("host/stats", { pageTitle: `Statistics: ${listing.title}`, listing, stats });
};
