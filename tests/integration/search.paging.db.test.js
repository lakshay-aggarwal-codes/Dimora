// P05-T03 against a real MongoDB: every sort order, 12 per page, no listing
// repeated or lost across pages, and the page past the end. Needs a MongoDB
// (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { searchPage, PAGE_SIZE } = require("../../src/services/search");

const TOTAL = 30;

// 30 published listings: prices with many ties (so the tie-break matters),
// ratings with ties, and a few with no reviews at all.
async function make() {
  const made = [];
  for (let i = 0; i < TOTAL; i += 1) {
    made.push(
      await createListing({
        title: `Stay ${String(i).padStart(2, "0")}`,
        description: i % 3 === 0 ? "villa with a pool near the sea" : "a quiet flat",
        price: 1000 + (i % 5) * 500, // 1000..3000, six listings per price
        ratingAvg: i % 4 === 0 ? 0 : 3 + (i % 3) * 0.5,
        ratingCount: i % 4 === 0 ? 0 : 1 + (i % 6),
      }),
    );
  }
  // Never in any result:
  await createListing({ title: "Draft", status: "draft" });
  await createListing({ title: "Deleted", deletedAt: new Date() });
  return made;
}

async function allPages(sort, extra = {}) {
  const pages = [];
  for (let page = 1; ; page += 1) {
    const result = await searchPage(Listing, { sort, page: String(page), ...extra });
    pages.push(result);
    if (page >= result.totalPages) break;
  }
  return pages;
}

describeDb("sorting and pagination", () => {
  useTestDb();
  beforeEach(make);

  test("30 listings are 3 pages of 12, 12 and 6, with the total on every page", async () => {
    const pages = await allPages("newest");
    expect(pages.map((p) => p.listings.length)).toEqual([12, 12, 6]);
    for (const page of pages) {
      expect(page).toMatchObject({ total: TOTAL, totalPages: 3, pageSize: PAGE_SIZE });
    }
  });

  test.each(["relevance", "price_asc", "price_desc", "rating", "newest"])(
    "%s: no listing appears twice and none is missing across pages",
    async (sort) => {
      const ids = (await allPages(sort)).flatMap((p) => p.listings.map((l) => String(l._id)));
      expect(ids).toHaveLength(TOTAL);
      expect(new Set(ids).size).toBe(TOTAL);
    },
  );

  test("paging a second time gives exactly the same order (it is stable)", async () => {
    for (const sort of ["price_asc", "rating", "relevance"]) {
      const first = (await allPages(sort)).flatMap((p) => p.listings.map((l) => String(l._id)));
      const second = (await allPages(sort)).flatMap((p) => p.listings.map((l) => String(l._id)));
      expect(second).toEqual(first);
    }
  });

  test("price low to high: prices never go down; equal prices keep a fixed order", async () => {
    const list = (await allPages("price_asc")).flatMap((p) => p.listings);
    const prices = list.map((l) => l.pricing.nightlyMinor);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    for (let i = 1; i < list.length; i += 1) {
      if (prices[i] === prices[i - 1]) expect(String(list[i]._id) > String(list[i - 1]._id)).toBe(true);
    }
  });

  test("price high to low", async () => {
    const prices = (await allPages("price_desc"))
      .flatMap((p) => p.listings)
      .map((l) => l.pricing.nightlyMinor);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
  });

  test("top rated: higher average first, then more reviews; unreviewed listings last", async () => {
    const list = (await allPages("rating")).flatMap((p) => p.listings);
    for (let i = 1; i < list.length; i += 1) {
      const [a, b] = [list[i - 1], list[i]];
      expect(a.ratingAvg > b.ratingAvg || (a.ratingAvg === b.ratingAvg && a.ratingCount >= b.ratingCount)).toBe(true);
    }
    expect(list[list.length - 1].ratingCount).toBe(0);
  });

  test("newest: the last one created is first", async () => {
    const list = (await allPages("newest")).flatMap((p) => p.listings);
    expect(list[0].title).toBe("Stay 29");
    expect(list[TOTAL - 1].title).toBe("Stay 00");
  });

  test("relevance with keywords: only the matching listings, over 1 page", async () => {
    const result = await searchPage(Listing, { keywords: "villa pool", page: "1" });
    expect(result.total).toBe(10); // every third listing
    const titles = result.listings.map((l) => l.title);
    expect(titles.every((t) => ["00", "03", "06", "09", "12", "15", "18", "21", "24", "27"].includes(t.slice(-2)))).toBe(true);
  });

  test("filters and paging work together: counts and pages are for the filtered set", async () => {
    const pages = await allPages("price_asc", { maxPrice: "1500" });
    const total = pages[0].total;
    expect(total).toBe(12); // 1000 and 1500: 6 + 6
    expect(pages).toHaveLength(1);
    expect(pages[0].listings).toHaveLength(12);
  });

  test("a page past the last is an empty, flagged result (not an error)", async () => {
    const result = await searchPage(Listing, { page: "4" });
    expect(result).toMatchObject({ listings: [], outOfRange: true, totalPages: 3, total: TOTAL });
  });

  describe("through the page", () => {
    test("/listings shows 12 cards on page 1 and 6 on page 3", async () => {
      const cards = (html) => (html.match(/class="card h-100 listing-card"/g) || []).length;
      const agent = createAgent();
      expect(cards((await agent.get("/listings")).text)).toBe(12);
      expect(cards((await agent.get("/listings?page=3")).text)).toBe(6);
    });

    test("page 2 and page 3 together never repeat a title from page 1", async () => {
      const agent = createAgent();
      const titles = async (q) =>
        [...(await agent.get(`/listings${q}`)).text.matchAll(/Stay \d\d/g)].map((m) => m[0]);
      const seen = new Set();
      for (const q of ["?sort=price_asc", "?sort=price_asc&page=2", "?sort=price_asc&page=3"]) {
        for (const title of new Set(await titles(q))) {
          expect(seen.has(title)).toBe(false);
          seen.add(title);
        }
      }
      expect(seen.size).toBe(TOTAL);
    });

    test("the page past the end renders the explanation with a link back", async () => {
      const res = await createAgent().get("/listings?page=7&sort=rating");
      expect(res.status).toBe(200);
      expect(res.text).toContain("That page does not exist");
      expect(res.text).toContain('href="/listings?sort=rating&amp;page=3"');
    });
  });
});
