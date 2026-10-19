// GET /api/listings/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD (P07-T04)
const Listing = require("../models/listing");
const { can } = require("../policies");
const { isPublic } = require("../utils/visibility");
const { NotFoundError } = require("../utils/errors");
const { getAvailability } = require("../services/availability");

module.exports.show = async (req, res) => {
  const listing = await Listing.findById(req.params.id).select(
    "owner status deletedAt minNights maxNights",
  );
  // Same visibility as the page: public listings for everybody, a draft or
  // unpublished one only for its host; anything else looks like it is missing.
  const visible =
    listing &&
    !listing.deletedAt &&
    (isPublic(listing) || can("listing:edit", req.user, listing));
  if (!visible) throw new NotFoundError("That listing does not exist.");

  const payload = await getAvailability(listing, req.query);
  // Availability changes with every booking: never serve a cached copy.
  res.set("Cache-Control", "no-store");
  res.json(payload);
};
