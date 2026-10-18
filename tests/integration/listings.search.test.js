// P05-T02 through the real page, without a database: the model and the ledger
// are stubbed so the test can see exactly what the page asks for.
const { createAgent } = require("../helpers/agent");
const { stubListingSearch } = require("../helpers/listingSearch");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const ledger = require("../../src/services/ledger");
const { PAGE_SIZE } = require("../../src/controllers/search");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const docs = (n) =>
  Array.from(
    { length: n },
    (_, i) => new Listing(buildListingData({ title: `Stay number ${i + 1}` })),
  );
const get = (url) => createAgent().get(url);
const inputValue = (html, id) =>
  (html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`)) || [""])[0].match(
    / value="([^"]*)"/,
  )?.[1];
const count = (html, re) => (html.match(re) || []).length;
const decode = (s) => s.replace(/&amp;/g, "&");

const TODAY = formatDateOnly(todayIn());
const LATER = formatDateOnly(addDays(todayIn(), 30));
const LATER2 = formatDateOnly(addDays(todayIn(), 33));

let unavailable;
beforeEach(() => {
  unavailable = jest
    .spyOn(ledger, "unavailableListingIds")
    .mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe("the filters reach the query", () => {
  test("no parameters: every public listing, page 1", async () => {
    const { find, chain } = stubListingSearch(docs(3));
    const res = await get("/listings");
    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledWith({ status: "published", deletedAt: null });
    expect(chain.skip).toHaveBeenCalledWith(0);
    expect(chain.limit).toHaveBeenCalledWith(PAGE_SIZE);
    expect(res.text).toContain("3 stays");
    expect(unavailable).not.toHaveBeenCalled();
  });

  test("destination, guests and type are applied; the form shows them", async () => {
    const { find } = stubListingSearch(docs(1));
    const res = await get("/listings?dest=Goa&guests=4&type=villa");
    const filter = find.mock.calls[0][0];
    expect(filter.status).toBe("published");
    const [{ $or }] = filter.$and; // the destination: a place-key prefix match
    expect($or[0].cityKey.test("goa")).toBe(true);
    expect($or[0].cityKey.test("panaji goa")).toBe(false);
    expect(filter["capacity.guests"]).toEqual({ $gte: 4 });
    expect(filter.propertyType).toEqual({ $in: ["villa"] });
    expect(inputValue(res.text, "dest")).toBe("Goa");
    expect(inputValue(res.text, "guests")).toBe("4");
    expect(res.text).toContain("for &ldquo;Goa&rdquo;");
  });

  test("the navbar's old `search` name and `amenities[]` still work", async () => {
    const { find } = stubListingSearch(docs(1));
    const res = await get(
      "/listings?search=Goa&amenities[]=wifi&amenities[]=pool",
    );
    expect(inputValue(res.text, "dest")).toBe("Goa");
    expect(find.mock.calls[0][0].amenities).toEqual({ $all: ["wifi", "pool"] });
  });

  test("the navbar search box sends `dest`", async () => {
    stubListingSearch(docs(1));
    const html = (await get("/listings")).text;
    expect(html).toMatch(
      /id="nav-search"[^>]*name="dest"|name="dest"[^>]*id="nav-search"/,
    );
  });

  test("unknown parameters and operator-looking ones change nothing", async () => {
    const { find } = stubListingSearch(docs(1));
    const res = await get(
      "/listings?foo=1&category=beaches&guests[$gt]=1&dest[$ne]=x&$where=1",
    );
    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledWith({ status: "published", deletedAt: null });
  });
});

describe("dates use the night ledger", () => {
  test("valid dates: listings with a taken night are left out", async () => {
    const taken = [docs(1)[0]._id];
    unavailable.mockResolvedValue(taken);
    const { find } = stubListingSearch(docs(2));
    const res = await get(`/listings?in=${LATER}&out=${LATER2}`);
    expect(res.status).toBe(200);
    const [from, to] = unavailable.mock.calls[0];
    expect(from.toISOString()).toBe(`${LATER}T00:00:00.000Z`);
    expect(to.toISOString()).toBe(`${LATER2}T00:00:00.000Z`);
    expect(find.mock.calls[0][0]._id).toEqual({ $nin: taken });
    expect(inputValue(res.text, "in")).toBe(LATER);
    expect(inputValue(res.text, "out")).toBe(LATER2);
  });

  test("nothing taken: no _id condition at all", async () => {
    const { find } = stubListingSearch(docs(1));
    await get(`/listings?in=${LATER}&out=${LATER2}`);
    expect(find.mock.calls[0][0]._id).toBeUndefined();
  });

  test("the date inputs cannot go before today", async () => {
    stubListingSearch(docs(1));
    const html = (await get("/listings")).text;
    expect(html).toMatch(new RegExp(`id="in"[^>]*min="${TODAY}"`));
  });

  test.each([
    [
      "a date that does not exist",
      "in=2026-02-30&out=2026-03-05",
      "Check-in must be a date like 2026-12-24.",
    ],
    ["only a check-in", `in=${LATER}`, "Choose a check-out date."],
    [
      "check-out before check-in",
      `in=${LATER2}&out=${LATER}`,
      "Check-out must be after check-in.",
    ],
    [
      "a check-in in the past",
      "in=2020-01-01&out=2020-01-05",
      "Check-in cannot be in the past.",
    ],
  ])(
    "%s: a message, the form keeps what was typed, the search still shows listings, the ledger is not asked",
    async (_name, query, message) => {
      stubListingSearch(docs(2));
      const res = await get(`/listings?dest=Goa&guests=2&${query}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('role="alert"');
      expect(res.text).toContain(message);
      expect(res.text).toContain("Some of your search was not used");
      const typed = Object.fromEntries(new URLSearchParams(query));
      for (const field of ["in", "out"]) {
        if (typed[field] !== undefined)
          expect(inputValue(res.text, field)).toBe(typed[field]);
      }
      expect(inputValue(res.text, "dest")).toBe("Goa");
      expect(res.text).toContain("Stay number 1");
      expect(unavailable).not.toHaveBeenCalled();
      expect(res.text).toContain('aria-invalid="true"');
    },
  );
});

describe("paging", () => {
  test("page 2 skips one page; the total and the links come from the same query", async () => {
    const { chain } = stubListingSearch(docs(12), { total: 30 });
    const res = await get("/listings?dest=Goa&guests=2&page=2");
    expect(chain.skip).toHaveBeenCalledWith(PAGE_SIZE);
    expect(res.text).toContain("30 stays");
    expect(res.text).toMatch(
      /aria-current="page"><span class="visually-hidden">Page <\/span>2</,
    );
  });

  test("pagination links keep the whole query; page 1 has no page parameter", async () => {
    stubListingSearch(docs(12), { total: 40 });
    const html = (
      await get(
        "/listings?dest=Goa&guests=2&type=villa&amenities=wifi&amenities=pool&page=2",
      )
    ).text;
    const links = [...html.matchAll(/class="page-link" href="([^"]+)"/g)].map(
      (m) => decode(m[1]),
    );
    expect(links).toContain(
      "/listings?dest=Goa&guests=2&type=villa&amenities=wifi&amenities=pool",
    );
    expect(links).toContain(
      "/listings?dest=Goa&guests=2&type=villa&amenities=wifi&amenities=pool&page=3",
    );
    expect(
      links.every((l) =>
        l.startsWith(
          "/listings?dest=Goa&guests=2&type=villa&amenities=wifi&amenities=pool",
        ),
      ),
    ).toBe(true);
  });

  test("a page past the end shows the last page; page 0 or text shows page 1 with a message", async () => {
    const { chain } = stubListingSearch(docs(3), { total: 30 });
    await get("/listings?page=99");
    expect(chain.skip).toHaveBeenLastCalledWith(PAGE_SIZE * 2); // 30 results = 3 pages
    chain.skip.mockClear();
    const res = await get("/listings?page=0");
    expect(chain.skip).toHaveBeenLastCalledWith(0);
    expect(res.text).toContain("Page must be a whole number from 1.");
  });

  test("a single page has no pagination", async () => {
    stubListingSearch(docs(5));
    expect((await get("/listings")).text).not.toContain(
      'aria-label="Pagination"',
    );
  });
});

describe("the rest of the state travels through the search form", () => {
  test("other filters become hidden inputs, page does not", async () => {
    stubListingSearch(docs(1));
    const html = (
      await get(
        "/listings?dest=Goa&type=villa&amenities=wifi&amenities=pool&minPrice=1000&sort=price_asc&page=2",
      )
    ).text;
    const hidden = [
      ...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g),
    ].map((m) => `${m[1]}=${m[2]}`);
    expect(hidden).toEqual([
      "minPrice=1000",
      "type=villa",
      "amenities=wifi",
      "amenities=pool",
      "sort=price_asc",
    ]);
  });
});

describe("empty results and safety", () => {
  test("a search with no match explains and offers to clear it", async () => {
    stubListingSearch([], { total: 0 });
    const html = (await get("/listings?dest=Atlantis")).text;
    expect(html).toContain("No stays found");
    expect(html).toContain("No stays match your search");
    expect(html).toMatch(/href="\/listings">Clear search</);
    expect(html).not.toContain("listing-card");
  });

  test("no listings at all is a different message", async () => {
    stubListingSearch([], { total: 0 });
    const html = (await get("/listings")).text;
    expect(html).toContain("No stays yet");
    expect(html).toContain('href="/host/listings/new"');
  });

  test("what was typed is escaped everywhere it comes back", async () => {
    stubListingSearch(docs(1));
    const evil = '"><script>alert(1)</script>';
    const res = await get(
      `/listings?dest=${encodeURIComponent(evil)}&in=${encodeURIComponent(evil)}&out=${encodeURIComponent(evil)}&guests=${encodeURIComponent(evil)}&sort=${encodeURIComponent(evil)}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(count(res.text, /&lt;script&gt;/g)).toBeGreaterThan(0);
  });

  test("the page title says it is a search when there are filters", async () => {
    stubListingSearch(docs(1));
    expect((await get("/listings?dest=Goa")).text).toMatch(
      /<title>Search results \| Dimora<\/title>/,
    );
    expect((await get("/listings")).text).toMatch(
      /<title>Explore stays \| Dimora<\/title>/,
    );
  });

  test("a database error is the error page, not a half page", async () => {
    stubListingSearch(docs(1));
    jest
      .spyOn(Listing, "countDocuments")
      .mockRejectedValue(new Error("db down"));
    expect((await get("/listings")).status).toBe(500);
  });
});
