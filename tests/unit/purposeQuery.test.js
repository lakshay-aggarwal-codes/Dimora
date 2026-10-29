// P15-T06: `purpose` in the listings URL.
const assert = require("node:assert/strict");
const { parseListingQuery } = require("../../src/validation/searchQuery");
const { listingsUrl } = require("../../src/utils/searchUrl");

test("a known purpose is kept in the state", () => {
  for (const p of ["work", "family", "weekend"]) assert.equal(parseListingQuery({ purpose: p }).state.purpose, p);
});

test("an unknown, repeated or odd purpose is an error that does not stop the page", () => {
  for (const bad of ["Work", "luxury", "constructor", "work,family", ["work", "family"], { a: 1 }, 1]) {
    const out = parseListingQuery({ purpose: bad, dest: "Goa" });
    assert.equal(out.state.purpose, undefined, JSON.stringify(bad));
    assert.ok(out.errors.purpose, JSON.stringify(bad));
    assert.equal(out.state.dest, "Goa");
  }
});

test("an empty purpose means none, without an error", () => {
  const out = parseListingQuery({ purpose: "" });
  assert.equal(out.state.purpose, undefined);
  assert.equal(out.errors.purpose, undefined);
});

test("purpose is carried by every link, after sort and before page, and a new choice goes back to page 1", () => {
  const state = { dest: "Goa", sort: "relevance", purpose: "work", page: 3 };
  assert.equal(listingsUrl(state, { page: 3 }), "/listings?dest=Goa&sort=relevance&purpose=work&page=3");
  assert.equal(listingsUrl(state, { purpose: "family" }), "/listings?dest=Goa&sort=relevance&purpose=family");
  assert.equal(listingsUrl(state, { purpose: undefined }), "/listings?dest=Goa&sort=relevance");
});
