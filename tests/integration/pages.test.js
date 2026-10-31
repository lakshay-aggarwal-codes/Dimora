// Real app, real views, no database: Listing.find is stubbed.
const { createAgent } = require("../helpers/agent");
const { testConfig } = require("../helpers/config");
const Listing = require("../../src/models/listing");
const { stubListingSearch } = require("../helpers/listingSearch");
const { buildListingData } = require("../helpers/factories");
const { stubListings } = require("../helpers/listingsStub");

test("GET /listings renders the index with the listings returned by the model", async () => {
  const doc = new Listing(
    buildListingData({ title: "Seaside Cottage", price: 12500 }),
  );
  stubListingSearch([doc]);
  const res = await createAgent().get("/listings");
  expect(res.status).toBe(200);
  expect(res.text).toContain("Seaside Cottage");
  expect(res.text).toContain("12,500");
});

test("login and signup pages render", async () => {
  const agent = createAgent();
  const login = await agent.get("/login");
  const signup = await agent.get("/signup");
  expect(login.status).toBe(200);
  expect(signup.status).toBe(200);
  expect(login.text).toMatch(/<form/i);
  expect(signup.text).toMatch(/<form/i);
});

test("anonymous visitors are redirected from /listings/new to /login", async () => {
  const res = await createAgent().get("/listings/new");
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("/login");
});

test("regression (P01-T04): a malformed id is a 404 page and an unknown path too", async () => {
  // Production mode: development mode intentionally shows the driver detail.
  const agent = createAgent({ config: testConfig({ isProduction: true }) });
  const bad = await agent.get("/listings/not-an-object-id");
  expect(bad.status).toBe(404);
  expect(bad.text).toMatch(/Page Not Found/);
  expect(bad.text).not.toMatch(/Cast to ObjectId/);
  expect((await agent.get("/nope")).status).toBe(404);
});

test("X-Request-Id is sent on every response", async () => {
  const res = await createAgent().get("/login");
  expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
});
