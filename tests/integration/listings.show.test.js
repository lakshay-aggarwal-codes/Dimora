// P01-T06 (D-04, D-05, D-14): the detail page through the real app and views.
// No database: Listing.findById is stubbed with a chainable, awaitable query.
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { publicPointOf } = require("../../src/utils/geo");

function stubFindById(doc) {
  const query = {
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}

async function showPage(overrides, options) {
  const doc = new Listing(buildListingData(overrides));
  stubFindById(doc);
  const res = await createAgent(options).get(`/listings/${doc._id}`);
  return { res, doc };
}

const mapTag = (html) => (html.match(/<div id="map"[^>]*>/) || [""])[0];

afterEach(() => {
  jest.restoreAllMocks();
});

describe("detail page", () => {
  test("renders title, price and the map data attributes", async () => {
    const { res, doc } = await showPage({ title: "Seaside Cottage", price: 12500 });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Seaside Cottage");
    expect(res.text).toContain("12,500");

    // The map is centred on the PUBLIC (approximate) point, never the precise one (P06-T02).
    const tag = mapTag(res.text);
    const point = publicPointOf(doc);
    expect(tag).toContain(`data-lng="${point.lng}"`);
    expect(tag).toContain(`data-lat="${point.lat}"`);
    expect(tag).not.toContain('data-lng="77.209"');
    expect(tag).not.toContain('data-lat="28.6139"');
    expect(tag).toContain('data-title="Seaside Cottage"');
    expect(tag).toContain('data-token="pk.test-public"');
    expect(res.text).toContain('<script src="/js/map.js"></script>');
  });

  test("regression D-04: no inline script carries listing data", async () => {
    const { res, doc } = await showPage({ title: "Seaside Cottage" });
    expect(res.text).not.toMatch(/const listing\b/);
    expect(res.text).not.toMatch(/const mapToken\b/);
    expect(res.text).not.toContain("JSON.stringify");
    expect(res.text).not.toContain("geomtry");
    // The raw document id must not be serialised into the page as JSON either.
    expect(res.text).not.toContain(`"_id":"${doc._id}"`);
  });

  test("regression D-05: a listing with no owner renders without a 500", async () => {
    const { res } = await showPage({ owner: undefined });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("Hosted by");
    expect(res.text).not.toContain("/edit");
  });

  test("regression D-14: a listing with no price shows a placeholder", async () => {
    const { res } = await showPage({ price: undefined });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Price not available");
    expect(res.text).not.toContain("NaN");
  });

  test("a listing with no image falls back to a placeholder picture", async () => {
    const { res } = await showPage({ image: undefined });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<img class="gallery-main-img" src="https:\/\/[^"]+"/);
  });

  test("a listing without usable coordinates shows a message instead of a map", async () => {
    const { res } = await showPage({ geometry: undefined });
    expect(res.status).toBe(200);
    expect(mapTag(res.text)).toBe("");
    expect(res.text).toContain("The map is not available for this listing yet.");
  });

  test("user text in the map attributes is escaped", async () => {
    const evil = `"><script>alert(1)</script>`;
    const { res } = await showPage({ title: evil });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>alert(1)</script>");
    const tag = mapTag(res.text);
    expect(tag).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(tag).not.toContain("<script");
    // EJS escapes " as &#34;, so the attribute value cannot be closed early.
    const [, value] = tag.match(/data-title="([^"]*)"/);
    expect(value).toBe("&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("a missing listing is a 404 page (P04-T07)", async () => {
    stubFindById(null);
    const res = await createAgent().get("/listings/507f1f77bcf86cd799439011");
    expect(res.status).toBe(404);
  });

  test("something that is not an id is the same 404 (no database call)", async () => {
    const find = stubFindById(null);
    for (const id of ["abc", "123", "%3Cscript%3E", "undefined"]) {
      expect((await createAgent().get(`/listings/${id}`)).status).toBe(404);
    }
    expect(find).not.toHaveBeenCalled();
  });
});
