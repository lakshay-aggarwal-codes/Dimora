// The listings page counts and pages its results (P05-T02), so a test that
// stubs the model needs find() to be chainable and countDocuments() to exist.
const Listing = require("../../src/models/listing");

/**
 * Makes Listing.find(...).sort().skip().limit() resolve to `listings` and
 * Listing.countDocuments() to `total` (default: how many listings there are).
 * @returns {{ find: jest.SpyInstance, countDocuments: jest.SpyInstance, chain: object }}
 */
function stubListingSearch(listings, { total } = {}) {
  const chain = {
    sort: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    // the empty-result suggestions look up popular destinations (P05-T05)
    select: jest.fn(() => chain),
    lean: jest.fn(() => chain),
    then: (resolve, reject) => Promise.resolve(listings).then(resolve, reject),
  };
  const find = jest.spyOn(Listing, "find").mockReturnValue(chain);
  const countDocuments = jest
    .spyOn(Listing, "countDocuments")
    .mockResolvedValue(total ?? listings.length);
  return { find, countDocuments, chain };
}

module.exports = { stubListingSearch };
