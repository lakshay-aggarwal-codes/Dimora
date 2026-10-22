// GET /api/listings/:id/quote?in=YYYY-MM-DD&out=YYYY-MM-DD&guests=N (P08-T02)
const Listing = require("../models/listing");
const { can } = require("../policies");
const { isPublic } = require("../utils/visibility");
const { NotFoundError } = require("../utils/errors");
const { getQuote } = require("../services/quoteService");

module.exports.show = async (req, res) => {
  const listing = await Listing.findById(req.params.id).select(
    "owner status deletedAt timezone checkInTime minNights maxNights capacity advanceNoticeHours sameDayCutoffTime pricing",
  );
  // Same visibility as the page and the availability API.
  const visible =
    listing &&
    !listing.deletedAt &&
    (isPublic(listing) || can("listing:edit", req.user, listing));
  if (!visible) throw new NotFoundError("That listing does not exist.");

  const payload = await getQuote(listing, req.query);
  res.set("Cache-Control", "no-store");
  res.json(payload);
};
