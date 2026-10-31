// P05-T03: the results bar, sort links, pagination and the "page does not
// exist" state on /listings. Real app and views; the database is stubbed.
const { createAgent } = require("../helpers/agent");
const { stubListings } = require("../helpers/listingsStub");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");

afterEach(() => jest.restoreAllMocks());

const docs = (n) =>
  Array.from({ length: n }, (_, i) => new Listing(buildListingData({ title: `Stay number ${i}` })));
const get = (query = "") => createAgent().get(`/listings${query}`);
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

describe("the results bar", () => {
  test("counts the stays; with one page it just says how many", async () => {
    stubListings(docs(5));
    const { text } = await get();
    expect(text).toMatch(/<p class="results-count" role="status">\s*5 stays/);
    expect(text).not.toContain('aria-label="Pagination"');
  });

  test("with several pages it says which stays are shown", async () => {
    stubListings(docs(12), { total: 30 });
    const { text } = await get("?page=2");
    expect(text).toMatch(/Showing 13&ndash;24 of 30 stays/);
    stubListings(docs(6), { total: 30 });
    expect((await get("?page=3")).text).toMatch(/Showing 25&ndash;30 of 30 stays/);
  });

  test("one stay is singular; none is 'No stays found'", async () => {
    stubListings(docs(1));
    expect((await get()).text).toMatch(/1 stay\s*<\/p>/);
    stubListings([]);
    expect((await get()).text).toMatch(/No stays found/);
  });
});

describe("sorting", () => {
  test("offers the five orders, marks the current one, and passes it to the query", async () => {
    const { calls } = stubListings(docs(3));
    const { text } = await get("?sort=price_desc");
    for (const label of ["Best match", "Price: low to high", "Price: high to low", "Top rated", "Newest"]) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/class="sort-link is-current" href="[^"]*sort=price_desc[^"]*" aria-current="true">Price: high to low/);
    expect(calls.sort).toEqual({ "pricing.nightlyMinor": -1, _id: -1 });
  });

  test("the default is the first choice, and its link has no sort parameter", async () => {
    stubListings(docs(3));
    const { text } = await get();
    expect(text).toMatch(/class="sort-link is-current" href="\/listings" aria-current="true">Best match/);
  });

  test("sort links keep the search and start again at page 1", async () => {
    stubListings(docs(12), { total: 40 });
    const { text } = await get("?destination=Goa&guests=2&page=3&sort=rating");
    const sortLinks = [...text.matchAll(/class="sort-link[^"]*" href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    expect(sortLinks).toHaveLength(5);
    for (const link of sortLinks) {
      expect(link).toContain("dest=Goa");
      expect(link).toContain("guests=2");
      expect(link).not.toContain("page=");
    }
    expect(sortLinks.some((l) => l.includes("sort=price_asc"))).toBe(true);
  });

  test("an unknown sort is ignored: the page renders in the default order", async () => {
    const { calls } = stubListings(docs(3));
    const res = await get("?sort=cheapest");
    expect(res.status).toBe(200);
    expect(calls.sort).toEqual({ ratingAvg: -1, ratingCount: -1, _id: -1 });
  });
});

describe("pagination", () => {
  test("page links keep the sort and the filters, page 1 has no page parameter", async () => {
    stubListings(docs(12), { total: 40 });
    const { text } = await get("?destination=Goa&sort=newest&page=2");
    const links = hrefs(text.slice(text.indexOf('aria-label="Pagination"')));
    expect(links.some((l) => l === "/listings?dest=Goa&sort=newest")).toBe(true); // page 1
    expect(links.some((l) => l === "/listings?dest=Goa&sort=newest&page=3")).toBe(true);
    expect(links.some((l) => l === "/listings?dest=Goa&sort=newest&page=4")).toBe(true);
    expect(text).toMatch(/aria-current="page"><span class="visually-hidden">Page <\/span>2</);
  });

  test("skip and limit follow the page", async () => {
    const { calls } = stubListings(docs(12), { total: 40 });
    await get("?page=3");
    expect(calls).toMatchObject({ skip: 24, limit: 12 });
  });

  test("a page past the last shows an explanation and a link back, and no listing cards", async () => {
    const { find } = stubListings(docs(12), { total: 30 });
    const res = await get("?destination=Goa&page=9");
    expect(res.status).toBe(200);
    expect(res.text).toContain("That page does not exist");
    expect(res.text).toContain("There are only 3 pages of results.");
    expect(hrefs(res.text)).toContain("/listings?dest=Goa&page=3");
    expect(res.text).toContain("Go to the last page");
    expect(res.text).not.toContain("listing-card");
    expect(find).not.toHaveBeenCalled(); // the list itself is not even fetched
  });

  test("with a single page of results, page 2 says there is only 1 page", async () => {
    stubListings([], { total: 5 });
    const { text } = await get("?page=2");
    expect(text).toContain("There is only 1 page of results.");
  });

  test("an invalid page number falls back to page 1", async () => {
    const { calls } = stubListings(docs(3));
    for (const q of ["?page=abc", "?page=0", "?page=-3", "?page=1.5"]) {
      const res = await get(q);
      expect(res.status).toBe(200);
      expect(calls.skip).toBe(0);
    }
    // An operator-shaped page is refused by the input guard (P17-T02).
    expect((await get("?page[$gt]=1")).status).toBe(400);
  });
});

describe("empty results", () => {
  test("a search with no matches says so and offers all stays", async () => {
    stubListings([]);
    const { text } = await get("?destination=Nowhere");
    expect(text).toContain("No stays match your search");
    expect(hrefs(text)).toContain("/listings");
  });

  test("an empty site invites the first listing instead", async () => {
    stubListings([]);
    const { text } = await get();
    expect(text).toContain("No stays yet");
    expect(hrefs(text)).toContain("/host/listings/new");
  });
});
