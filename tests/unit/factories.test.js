// Test-data builders produce documents the models accept (no database needed).
const assert = require("node:assert/strict");
const Listing = require("../../src/models/listing");
const { buildListingData, buildUserData } = require("../helpers/factories");

test("buildListingData passes Listing validation", async () => {
  await new Listing(buildListingData()).validate();
});

test("a listing without geometry fails validation (the baseline seed defect, D-05)", async () => {
  const data = buildListingData();
  delete data.geometry;
  await assert.rejects(() => new Listing(data).validate(), /geometry/);
});

test("overrides win and generated users are unique", () => {
  assert.equal(buildListingData({ price: 1 }).price, 1);
  const a = buildUserData();
  const b = buildUserData();
  assert.notEqual(a.username, b.username);
  assert.notEqual(a.email, b.email);
  assert.equal(buildUserData({ username: "ann" }).username, "ann");
});
