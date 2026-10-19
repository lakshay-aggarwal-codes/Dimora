// P05-T04: the optional `vibe` field of the Listing model.
const Listing = require("../../src/models/listing");
const { buildListingData } = require("../helpers/factories");
const { VIBE_VALUES } = require("../../src/config/constants");

describe("Listing.vibe", () => {
  test("is optional", () => {
    const listing = new Listing(buildListingData());
    expect(listing.validateSync()).toBeUndefined();
    expect(listing.vibe).toBeUndefined();
  });

  test.each(VIBE_VALUES)("%s is accepted", (vibe) => {
    expect(new Listing(buildListingData({ vibe })).validateSync()).toBeUndefined();
  });

  test("a value outside the list is refused", () => {
    const error = new Listing(buildListingData({ vibe: "moon" })).validateSync();
    expect(error.errors.vibe).toBeTruthy();
  });
});
