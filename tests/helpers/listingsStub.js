// Stands in for the database in page tests that load /listings (P05-T03): the
// page now asks for a sorted, skipped, limited list and a total count, so a
// plain mockResolvedValue([...]) on Listing.find is no longer enough.
const Listing = require("../../src/models/listing");

/**
 * @param {object[]} docs what the page gets back
 * @param {{ total?: number }} [options] the total count (default: docs.length)
 * @returns {{ find: jest.SpyInstance, count: jest.SpyInstance, calls: object }}
 */
function stubListings(docs = [], { total } = {}) {
  const calls = {};
  const chain = {
    sort(arg) {
      calls.sort = arg;
      return chain;
    },
    skip(arg) {
      calls.skip = arg;
      return chain;
    },
    limit(arg) {
      calls.limit = arg;
      return chain;
    },
    select() {
      return chain;
    },
    lean() {
      return chain;
    },
    then(resolve, reject) {
      return Promise.resolve(docs).then(resolve, reject);
    },
  };
  const find = jest.spyOn(Listing, "find").mockImplementation((filter, projection) => {
    calls.filter = filter;
    calls.projection = projection;
    return chain;
  });
  const count = jest
    .spyOn(Listing, "countDocuments")
    .mockImplementation(async (filter) => {
      calls.countFilter = filter;
      return total ?? docs.length;
    });
  return { find, count, calls };
}

module.exports = { stubListings };
