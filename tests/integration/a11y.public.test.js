// P18-T03: axe-core on the pages anyone can open, rendered by the real app and
// real views (database stubbed). jsdom has no layout, so colour contrast is
// checked separately (tests/unit/contrast.test.js).
const { createAgent } = require("../helpers/agent");
const { stubListings } = require("../helpers/listingsStub");
const { buildListingData } = require("../helpers/factories");
const { audit, describe: show } = require("../helpers/a11y");
const Listing = require("../../src/models/listing");

afterEach(() => jest.restoreAllMocks());

const docs = (n) =>
  Array.from(
    { length: n },
    (_, i) =>
      new Listing(buildListingData({ title: `Stay number ${i}`, city: "Goa" })),
  );
const get = (url) => createAgent().get(url);
const clean = async (res) => {
  expect(res.status).toBe(200);
  const violations = await audit(res.text);
  if (violations.length)
    throw new Error(
      `axe found ${violations.length} problem(s):\n${show(violations)}`,
    );
};

function stubFindById(doc) {
  const query = {
    populate: () => query,
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}

describe("axe: public pages", () => {
  test("home", async () => {
    stubListings(docs(6));
    await clean(await get("/"));
  });
  test("search results (with filters in the query)", async () => {
    stubListings(docs(12), { total: 40 });
    await clean(
      await get("/listings?destination=Goa&guests=2&page=2&sort=rating"),
    );
  });
  test("search with no results", async () => {
    stubListings([]);
    await clean(await get("/listings?destination=Nowhere"));
  });
  test("a listing page with reviews", async () => {
    stubFindById({
      _id: "64b0f0f0f0f0f0f0f0f0aaaa",
      status: "published",
      title: "Sea house",
      description: "A quiet house by the sea.\nTwo rooms.",
      location: "Candolim",
      country: "India",
      price: 4500,
      reviews: [
        {
          _id: "64b0f0f0f0f0f0f0f0f0e001",
          rating: 4,
          comment: "Lovely",
          legacy: true,
          createdAt: new Date("2026-03-01"),
          author: { _id: "64b0f0f0f0f0f0f0f0f0ffff", username: "guest1" },
        },
        {
          _id: "64b0f0f0f0f0f0f0f0f0e002",
          rating: 5,
          comment: "Perfect",
          createdAt: new Date("2026-04-01"),
          author: { _id: "64b0f0f0f0f0f0f0f0f0fffe", username: "guest2" },
        },
      ],
      ratingSum: 9,
      ratingCount: 2,
      ratingAvg: 4.5,
    });
    await clean(await get("/listings/64b0f0f0f0f0f0f0f0f0aaaa"));
  });
  test("a listing page with the least data", async () => {
    stubFindById({
      _id: "64b0f0f0f0f0f0f0f0f0aaab",
      status: "published",
      title: "T",
      description: "d",
      reviews: [],
    });
    await clean(await get("/listings/64b0f0f0f0f0f0f0f0f0aaab"));
  });
  test.each(["/about", "/privacy", "/terms", "/login", "/signup"])(
    "%s",
    async (url) => clean(await get(url)),
  );
  test("the not-found page", async () => {
    const res = await get("/no-such-page");
    expect(res.status).toBe(404);
    const violations = await audit(res.text);
    if (violations.length) throw new Error(show(violations));
  });
});
