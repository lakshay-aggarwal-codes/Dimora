// P03-T03: the listings page builds its cards with the listing-card partial.
// No database: Listing.find is stubbed.
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { stubListings } = require("../helpers/listingsStub");

afterEach(() => jest.restoreAllMocks());

test("each listing is a card with its link, title, place and formatted price", async () => {
  const docs = [
    new Listing(
      buildListingData({
        title: "Seaside Cottage",
        price: 4500,
        location: "Goa",
        country: "India",
      }),
    ),
    new Listing(buildListingData({ title: "Hill Cabin", price: 1200 })),
  ];
  stubListings(docs);
  const res = await createAgent().get("/listings");
  expect(res.status).toBe(200);
  expect(res.text.match(/class="card h-100 listing-card"/g)).toHaveLength(2);
  for (const doc of docs)
    expect(res.text).toContain(`href="/listings/${doc._id}"`);
  expect(res.text).toContain("₹4,500");
  expect(res.text).toContain("₹1,200");
  expect(res.text).toContain("Goa, India");
  expect(res.text).toContain("+18% GST");
  expect(res.text).not.toMatch(/style="/);
});

test("a listing without a price shows 'Price not set' instead of breaking the page", async () => {
  const doc = new Listing(buildListingData({ title: "No Price" }));
  doc.set("pricing.nightlyMinor", undefined);
  stubListings([doc]);
  const res = await createAgent().get("/listings");
  expect(res.status).toBe(200);
  expect(res.text).toContain("Price not set");
});

test("no listings is still a page (no cards)", async () => {
  stubListings([]);
  const res = await createAgent().get("/listings");
  expect(res.status).toBe(200);
  expect(res.text).not.toContain("listing-card");
});
