// P06-T04: the list/map toggle and map panel on /listings (markup only; the
// behaviour is in tests/unit/searchMapScript.test.js). Database stubbed.
const { createAgent } = require("../helpers/agent");
const { stubListings } = require("../helpers/listingsStub");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");

afterEach(() => jest.restoreAllMocks());

const docs = (n) =>
  Array.from({ length: n }, (_, i) => new Listing(buildListingData({ title: `Stay number ${i}` })));
const page = async (query = "") => (await createAgent().get(`/listings${query}`)).text;

describe("list / map toggle", () => {
  test("the toggle is in the page but hidden until the script confirms Mapbox GL works", async () => {
    stubListings(docs(2));
    const text = await page();
    expect(text).toMatch(/<button type="button" class="btn btn-outline-dark" id="map-toggle"[^>]*aria-controls="search-map-panel"[^>]*aria-pressed="false"[^>]*hidden>Show map<\/button>/);
    expect(text).toContain('<script src="/js/searchMap.js"></script>');
  });

  test("the map panel starts hidden, inside the split, after the results region", async () => {
    stubListings(docs(2));
    const text = await page();
    const split = text.indexOf('id="search-split" data-view="list"');
    const results = text.indexOf('<div id="results" class="results-region">');
    const panel = text.indexOf('id="search-map-panel"');
    expect(split).toBeGreaterThan(-1);
    expect(results).toBeGreaterThan(split);
    expect(panel).toBeGreaterThan(results);
    expect(text).toMatch(/<section class="search-map-panel" id="search-map-panel"[^>]*hidden>/);
  });

  test("the panel has the opt-in checkbox (off), the status line and a labelled map region", async () => {
    stubListings(docs(1));
    const text = await page();
    expect(text).toMatch(/<input class="form-check-input" type="checkbox" id="map-follow">/);
    expect(text).not.toMatch(/id="map-follow"[^>]*checked/);
    expect(text).toContain("Search as I move the map");
    expect(text).toMatch(/id="map-status" role="status" aria-live="polite"/);
    expect(text).toMatch(/id="search-map" role="region" aria-label="Map of the stays in these results"/);
  });

  test("the map carries the public token and the page's own filters, nothing else", async () => {
    stubListings(docs(1));
    const text = await page("?dest=Goa&guests=2&sort=price_asc&page=2");
    const tag = /<div id="search-map"[^>]*>/.exec(text)[0];
    expect(tag).toContain('data-token="pk.test-public"');
    expect(tag).toContain('data-endpoint="/api/search/map"');
    const query = new URLSearchParams(/data-query="([^"]*)"/.exec(tag)[1].replace(/&amp;/g, "&"));
    expect(query.get("dest")).toBe("Goa");
    expect(query.get("guests")).toBe("2");
    expect(query.has("page")).toBe(false); // the map has no pages
  });

  test("every card carries its id so the map can light it up", async () => {
    const list = docs(3);
    stubListings(list);
    const text = await page();
    for (const doc of list) expect(text).toContain(`<div class="col" data-listing-id="${doc._id}">`);
  });

  test("the page source has no precise coordinates and no listing JSON in a script", async () => {
    const list = docs(1);
    stubListings(list);
    const text = await page();
    expect(text).not.toContain("JSON.stringify");
    expect(text).not.toMatch(/const (listings?|features)\b/);
    const [lng, lat] = list[0].geometry.coordinates;
    expect(text).not.toContain(String(lng));
    expect(text).not.toContain(String(lat));
  });
});
