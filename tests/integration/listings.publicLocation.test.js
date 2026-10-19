// P06-T02: the detail page never contains the precise location. Real app and
// views; the database is stubbed.
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { publicPointOf, distanceMeters, MIN_OFFSET_M, MAX_OFFSET_M } = require("../../src/utils/geo");

afterEach(() => jest.restoreAllMocks());

const PRECISE = { lng: 77.20931, lat: 28.61391 };
const LEAKS = [
  "77.20931",
  "28.61391",
  "[77.20931,28.61391]",
  "[77.20931, 28.61391]",
  "28.61391,77.20931",
  "12 Beach Road, Flat 4",
  "Flat 4",
  "110001",
];

function stubFindById(doc) {
  const query = {
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}

async function page(overrides = {}) {
  const doc = new Listing(
    buildListingData({
      geometry: { type: "Point", coordinates: [PRECISE.lng, PRECISE.lat] },
      address: { line1: "12 Beach Road, Flat 4", city: "Goa", state: "Goa", country: "India", postalCode: "110001" },
      ...overrides,
    }),
  );
  stubFindById(doc);
  const res = await createAgent().get(`/listings/${doc._id}`);
  return { res, doc };
}

const mapTag = (html) => (html.match(/<div id="map"[^>]*>/) || [""])[0];
const mapPoint = (html) => {
  const tag = mapTag(html);
  return { lng: Number(/data-lng="([^"]+)"/.exec(tag)[1]), lat: Number(/data-lat="([^"]+)"/.exec(tag)[1]) };
};

test("the page source contains neither the precise coordinates nor the street address", async () => {
  const { res } = await page();
  expect(res.status).toBe(200);
  for (const text of LEAKS) expect(res.text).not.toContain(text);
});

test("the map is centred on a point 300 to 800 metres away", async () => {
  const { res } = await page();
  const distance = distanceMeters(PRECISE, mapPoint(res.text));
  expect(distance).toBeGreaterThanOrEqual(MIN_OFFSET_M);
  expect(distance).toBeLessThanOrEqual(MAX_OFFSET_M);
});

test("the same listing shows the same point on every load", async () => {
  const doc = new Listing(buildListingData());
  stubFindById(doc);
  const agent = createAgent();
  const first = mapTag((await agent.get(`/listings/${doc._id}`)).text);
  for (let i = 0; i < 5; i += 1) {
    expect(mapTag((await agent.get(`/listings/${doc._id}`)).text)).toBe(first);
  }
});

test("it holds for many different listings (many ids)", async () => {
  for (let i = 0; i < 25; i += 1) {
    const { res } = await page();
    for (const text of LEAKS.slice(0, 4)) expect(res.text).not.toContain(text);
    expect(distanceMeters(PRECISE, mapPoint(res.text))).toBeGreaterThanOrEqual(MIN_OFFSET_M);
  }
});

test("a stored public point is what is shown", async () => {
  const doc = new Listing(buildListingData());
  await doc.validate(); // the model computes publicGeometry
  expect(doc.publicGeometry.coordinates).toHaveLength(2);
  stubFindById(doc);
  const res = await createAgent().get(`/listings/${doc._id}`);
  expect(mapPoint(res.text)).toEqual(publicPointOf(doc));
  expect(mapPoint(res.text)).toEqual({ lng: doc.publicGeometry.coordinates[0], lat: doc.publicGeometry.coordinates[1] });
});

test("a listing with no usable point still says the map is not available", async () => {
  const { res } = await page({ geometry: undefined });
  expect(mapTag(res.text)).toBe("");
  expect(res.text).toContain("The map is not available for this listing yet.");
});
