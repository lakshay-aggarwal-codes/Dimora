// P06-T01: the page source carries the public Mapbox token and never the
// server (geocoding) token. No database: Listing.findById is stubbed.
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const { testConfig } = require("../helpers/config");
const Listing = require("../../src/models/listing");

const SERVER_TOKEN = "sk.SERVER-ONLY-geocoding-token";
const PUBLIC_TOKEN = "pk.PUBLIC-restricted-map-token";

const config = testConfig({
  mapbox: {
    serverToken: SERVER_TOKEN,
    publicToken: PUBLIC_TOKEN,
    permanentGeocoding: false,
  },
});

function stubFindById(doc) {
  const query = {
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("token split", () => {
  test("detail page contains the public token and not the server token", async () => {
    const doc = new Listing(buildListingData({ title: "Seaside Cottage" }));
    stubFindById(doc);
    const res = await createAgent({ config }).get(`/listings/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`data-token="${PUBLIC_TOKEN}"`);
    expect(res.text).not.toContain(SERVER_TOKEN);
    expect(res.text).not.toMatch(/sk\.[A-Za-z0-9_-]/);
  });

  test("response headers never carry either token's secret part", async () => {
    const res = await createAgent({ config }).get("/login");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SERVER_TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain("SERVER-ONLY");
  });

  test("a missing page (404) does not leak the server token", async () => {
    const res = await createAgent({ config }).get("/no-such-page");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(SERVER_TOKEN);
  });
});
