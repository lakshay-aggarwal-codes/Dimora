// P05-T04 through the real page, without a database: the model and the ledger
// are stubbed so the test sees what the page asks for and what it shows.
const { createAgent } = require("../helpers/agent");
const { stubListingSearch } = require("../helpers/listingSearch");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const ledger = require("../../src/services/ledger");
const { CATEGORIES } = require("../../src/config/categories");

const docs = (n) =>
  Array.from({ length: n }, (_, i) => new Listing(buildListingData({ title: `Stay number ${i + 1}` })));
const get = (url) => createAgent().get(url);
const count = (html, re) => (html.match(re) || []).length;
const decode = (s) => s.replace(/&amp;/g, "&");
const stripLinks = (html) =>
  [...html.matchAll(/<a class="filter( is-active)?" href="([^"]*)"( aria-current="true")?>/g)].map((m) => ({
    active: Boolean(m[1]),
    href: decode(m[2]),
    current: Boolean(m[3]),
  }));
const chipLinks = (html) => {
  const nav = (html.match(/<nav class="filter-chips"[\s\S]*?<\/nav>/) || [""])[0];
  return [...nav.matchAll(/<a class="filter-chip" href="([^"]*)">\s*<span class="visually-hidden">Remove filter: <\/span>\s*<span>([^<]*)<\/span>/g)].map(
    (m) => ({ href: decode(m[1]), label: m[2] }),
  );
};
const panelHtml = (html) => (html.match(/<details class="filter-panel"[\s\S]*?<\/details>/) || [""])[0];

beforeEach(() => {
  jest.spyOn(ledger, "unavailableListingIds").mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe("the category strip", () => {
  test("All stays first, then every category, all plain links", async () => {
    stubListingSearch(docs(1));
    const { text } = await get("/listings");
    const links = stripLinks(text);
    expect(links).toHaveLength(CATEGORIES.length + 1);
    expect(links[0].href).toBe("/listings");
    expect(links.slice(1).map((link) => link.href)).toEqual(
      CATEGORIES.map((category) => `/listings?category=${category.slug}`),
    );
    expect(text).toContain('<nav class="filter-nav" aria-label="Categories">');
    expect(text).not.toContain('<div class="filter"');
  });

  test("with no category, All stays is the current one", async () => {
    stubListingSearch(docs(1));
    const links = stripLinks((await get("/listings")).text);
    expect(links.filter((link) => link.active)).toEqual([{ active: true, href: "/listings", current: true }]);
  });

  test("the chosen category is marked, in words and by aria-current", async () => {
    stubListingSearch(docs(1));
    const links = stripLinks((await get("/listings?category=beach")).text);
    const marked = links.filter((link) => link.active);
    expect(marked).toEqual([{ active: true, href: "/listings?category=beach", current: true }]);
    expect(links[0].active).toBe(false);
  });

  test("a category link keeps the search and the filters and starts at page 1", async () => {
    stubListingSearch(docs(1));
    const links = stripLinks((await get("/listings?dest=Goa&guests=2&minPrice=500&page=2&category=beach")).text);
    const cabins = links.find((link) => link.href.includes("category=cabins"));
    expect(cabins.href).toBe("/listings?dest=Goa&guests=2&category=cabins&minPrice=500");
    expect(links[0].href).toBe("/listings?dest=Goa&guests=2&minPrice=500");
  });

  test.each(CATEGORIES.map((category) => [category.slug, category]))(
    "%s asks the database only for matching listings",
    async (_slug, category) => {
      const { find } = stubListingSearch(docs(1));
      const res = await get(`/listings?category=${category.slug}`);
      expect(res.status).toBe(200);
      const filter = find.mock.calls[0][0];
      expect(filter.status).toBe("published");
      expect(filter.$and).toEqual([
        category.field === "amenities"
          ? { amenities: { $all: [...category.values] } }
          : { [category.field]: { $in: [...category.values] } },
      ]);
    },
  );

  test("an unknown category shows a message and searches everything", async () => {
    const { find } = stubListingSearch(docs(1));
    const res = await get("/listings?category=castles");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Category is not one of the choices.");
    expect(find).toHaveBeenCalledWith({ status: "published", deletedAt: null });
    expect(stripLinks(res.text).filter((link) => link.active)).toHaveLength(1);
  });

  test("two categories at once are ignored; an operator is refused before the search runs (P17-T02)", async () => {
    const { find } = stubListingSearch(docs(1));
    const dup = await get("/listings?category=beach&category=cabins");
    expect(dup.status).toBe(200);
    expect(find.mock.calls.at(-1)[0]).toEqual({ status: "published", deletedAt: null });
    const calls = find.mock.calls.length;
    const op = await get("/listings?category[$ne]=beach");
    expect(op.status).toBe(400);
    expect(find.mock.calls.length).toBe(calls);
  });
});

describe("chips for the active filters", () => {
  test("no filters, no chip row", async () => {
    stubListingSearch(docs(1));
    expect((await get("/listings")).text).not.toContain('class="filter-chips"');
  });

  test("one chip per filter, each removing only itself", async () => {
    stubListingSearch(docs(1));
    const { text } = await get("/listings?dest=Goa&category=beach&type=villa&amenities=wifi&minPrice=1000");
    const chips = chipLinks(text);
    expect(chips.map((chip) => chip.label)).toEqual(["Where: Goa", "Beach", "From ₹1,000 a night", "Villa", "Wi-Fi"]);
    expect(chips[1].href).toBe("/listings?dest=Goa&minPrice=1000&type=villa&amenities=wifi");
    expect(chips[3].href).toBe("/listings?dest=Goa&category=beach&minPrice=1000&amenities=wifi");
  });

  test("chip text is escaped", async () => {
    stubListingSearch(docs(1));
    const { text } = await get("/listings?dest=%3Cscript%3Ealert(1)%3C/script%3E");
    expect(text).not.toContain("<script>alert(1)</script>");
    expect(chipLinks(text)[0].label).toBe("Where: &lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("the filter panel", () => {
  test("is a plain GET form inside <details>, closed unless something is wrong", async () => {
    stubListingSearch(docs(1));
    const { text } = await get("/listings");
    const panel = panelHtml(text);
    expect(panel).toContain('<details class="filter-panel" id="filter-panel">');
    expect(panel).toMatch(/<form method="GET" action="\/listings" class="filter-panel-form"/);
    expect(panel).toContain("Reset filters");
    expect(panel).toContain("Show stays");
    expect(panel).not.toMatch(/\son[a-z]+=/); // no inline handlers (the CSP forbids them)
  });

  test("has every control the filters need, named like the URL", async () => {
    stubListingSearch(docs(1));
    const panel = panelHtml((await get("/listings")).text);
    for (const name of ["minPrice", "maxPrice", "bedrooms"]) expect(panel).toContain(`name="${name}"`);
    expect(count(panel, /name="type"/g)).toBe(8);
    expect(count(panel, /name="roomType"/g)).toBe(3);
    expect(count(panel, /name="amenities"/g)).toBe(14);
    expect(panel).toContain('name="instantBook" value="true"');
    expect(count(panel, /name="access"/g)).toBe(6);
    expect(count(panel, /<fieldset/g)).toBe(4);
    expect(count(panel, /<legend/g)).toBe(4);
  });

  test("shows the current choices", async () => {
    stubListingSearch(docs(1));
    const panel = panelHtml(
      (await get("/listings?minPrice=1000&maxPrice=5000&bedrooms=2&type=villa&type=cabin&roomType=private_room&amenities=pool&instantBook=true")).text,
    );
    expect(panel).toMatch(/id="minPrice"[^>]*value="1000"/);
    expect(panel).toMatch(/id="maxPrice"[^>]*value="5000"/);
    expect(panel).toMatch(/id="bedrooms"[^>]*value="2"/);
    for (const id of ["type-villa", "type-cabin", "roomType-private_room", "amenities-pool", "instantBook"]) {
      expect(panel).toMatch(new RegExp(`id="${id}" checked|id="${id}"[^>]* checked`));
    }
    expect(panel).not.toMatch(/id="type-house"[^>]* checked/);
    // price range 1, two types 2, room type 1, bedrooms 1, amenity 1, instant book 1
    expect(panel).toContain('<span class="filter-count" aria-hidden="true">7</span>');
  });

  test("carries the rest of the search as hidden inputs, and never the page", async () => {
    stubListingSearch(docs(1));
    const panel = panelHtml((await get("/listings?dest=Goa&in=2099-01-10&out=2099-01-12&guests=2&category=beach&sort=rating&page=2")).text);
    const hidden = [...panel.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]);
    expect(hidden).toEqual([
      ["dest", "Goa"],
      ["in", "2099-01-10"],
      ["out", "2099-01-12"],
      ["guests", "2"],
      ["category", "beach"],
      ["sort", "rating"],
    ]);
  });

  test("the search form carries the panel's filters and the category", async () => {
    stubListingSearch(docs(1));
    const { text } = await get("/listings?dest=Goa&category=beach&type=villa&minPrice=1000");
    const search = (text.match(/<form method="GET" action="\/listings" class="search-panel"[\s\S]*?<\/form>/) || [""])[0];
    const hidden = [...search.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]);
    expect(hidden).toEqual([
      ["category", "beach"],
      ["minPrice", "1000"],
      ["type", "villa"],
    ]);
  });

  test("a wrong value opens the panel, keeps what was typed and says what was not used", async () => {
    const { find } = stubListingSearch(docs(1));
    const res = await get("/listings?minPrice=abc&maxPrice=5000");
    const panel = panelHtml(res.text);
    expect(panel).toMatch(/^<details class="filter-panel" id="filter-panel" open>/);
    expect(panel).toMatch(/id="minPrice"[^>]*value="abc"[^>]*aria-invalid="true"/);
    expect(res.text).toContain("Some of your search was not used");
    expect(find.mock.calls[0][0]["pricing.nightlyMinor"]).toEqual({ $lte: 500000 });
  });

  test("the results area and its loading hooks are there", async () => {
    stubListingSearch(docs(1));
    const { text } = await get("/listings");
    expect(text).toContain('<div id="results" class="results-region">');
    expect(text).toContain('id="search-status" role="status" hidden');
    expect(text).toContain('<script src="/js/filters.js"></script>');
  });
});

describe("empty results", () => {
  test("with a category: says so and offers to drop the filters but keep the search", async () => {
    stubListingSearch([], { total: 0 });
    const { text } = await get("/listings?dest=Goa&category=farm-stays&amenities=pool");
    expect(text).toContain("No stays match your search");
    const link = text.match(/<a href="([^"]*)">Remove the filters and category, keep my search<\/a>/);
    expect(link).not.toBeNull();
    expect(decode(link[1])).toBe("/listings?dest=Goa");
  });

  test("without filters there is no such link", async () => {
    stubListingSearch([], { total: 0 });
    expect((await get("/listings")).text).not.toContain("Remove the filters and category");
  });
});
