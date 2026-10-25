// P15-T04: the "Available +-3 days" toggle on /listings, through the real page
// without a database (the model and the ledger are stubbed).
const { createAgent } = require("../helpers/agent");
const { stubListingSearch } = require("../helpers/listingSearch");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const ledger = require("../../src/services/ledger");
const { parseListingQuery } = require("../../src/validation/searchQuery");
const { listingFilterFor } = require("../../src/services/listingFilter");
const { activeChips } = require("../../src/utils/filterChips");
const {
  listingsUrl,
  hiddenFields,
  queryPairs,
} = require("../../src/utils/searchUrl");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const IN = formatDateOnly(addDays(todayIn(), 30));
const OUT = formatDateOnly(addDays(todayIn(), 33));
const docs = (n) =>
  Array.from(
    { length: n },
    (_, i) => new Listing(buildListingData({ title: `Stay ${i + 1}` })),
  );
const get = (url) => createAgent().get(url);
const decode = (s) => s.replace(/&amp;/g, "&");

let strict;
let flexible;
beforeEach(() => {
  strict = jest.spyOn(ledger, "unavailableListingIds").mockResolvedValue([]);
  flexible = jest
    .spyOn(ledger, "unavailableListingIdsFlexible")
    .mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe("the parameter", () => {
  const parse = (q) => parseListingQuery(q);
  test("flex=3 with valid dates is on: state, stay and no error", () => {
    const parsed = parse({ in: IN, out: OUT, flex: "3" });
    expect(parsed.state.flex).toBe(3);
    expect(parsed.stay.flexDays).toBe(3);
    expect(parsed.errors.flex).toBeUndefined();
  });
  test("without flex, or with 0 or an empty value, it is off and not an error", () => {
    for (const q of [
      { in: IN, out: OUT },
      { in: IN, out: OUT, flex: "" },
      { in: IN, out: OUT, flex: "0" },
    ]) {
      const parsed = parse(q);
      expect(parsed.state.flex).toBeUndefined();
      expect(parsed.stay.flexDays).toBe(0);
      expect(parsed.errors.flex).toBeUndefined();
    }
  });
  test("anything else is a message and does not turn it on; the dates still search", () => {
    for (const flex of [
      "1",
      "7",
      "true",
      "-3",
      "3.0",
      "99",
      ["3", "3"],
      { a: 1 },
    ]) {
      const parsed = parse({ in: IN, out: OUT, flex });
      expect(parsed.errors.flex).toMatch(/3 days either side/);
      expect(parsed.state.flex).toBeUndefined();
      expect(parsed.stay.flexDays).toBe(0);
      expect(parsed.stay.checkIn).toBeDefined();
    }
  });
  test("without valid dates it does nothing (no stay, no flex in the state)", () => {
    const parsed = parse({ flex: "3" });
    expect(parsed.stay).toBeNull();
    expect(parsed.state.flex).toBeUndefined();
    expect(
      parse({ in: "2026-13-45", out: OUT, flex: "3" }).state.flex,
    ).toBeUndefined();
  });
});

describe("the filter", () => {
  test("flex on: the flexible ledger query decides, with today as the earliest start", async () => {
    flexible.mockResolvedValue(["x1", "x2"]);
    const { filter, takenIds } = await listingFilterFor({
      in: IN,
      out: OUT,
      flex: "3",
    });
    expect(strict).not.toHaveBeenCalled();
    expect(flexible).toHaveBeenCalledTimes(1);
    const [from, to, days, options] = flexible.mock.calls[0];
    expect([formatDateOnly(from), formatDateOnly(to), days]).toEqual([
      IN,
      OUT,
      3,
    ]);
    expect(options.earliest.getTime()).toBe(todayIn().getTime());
    expect(filter._id).toEqual({ $nin: ["x1", "x2"] });
    expect(takenIds).toEqual(["x1", "x2"]);
  });
  test("flex off: the strict query, exactly as before", async () => {
    strict.mockResolvedValue(["y"]);
    const { filter } = await listingFilterFor({ in: IN, out: OUT });
    expect(flexible).not.toHaveBeenCalled();
    expect(filter._id).toEqual({ $nin: ["y"] });
  });
  test("no dates: neither query", async () => {
    await listingFilterFor({ flex: "3" });
    expect(strict).not.toHaveBeenCalled();
    expect(flexible).not.toHaveBeenCalled();
  });
});

describe("links and chips", () => {
  const state = { in: IN, out: OUT, guests: 2, flex: 3, sort: "price_asc" };
  test("flex travels in every link, in a fixed place, and a page change keeps it", () => {
    expect(queryPairs(state).map(([k]) => k)).toEqual([
      "in",
      "out",
      "guests",
      "flex",
      "sort",
    ]);
    expect(listingsUrl(state, { page: 2 })).toContain("flex=3");
    expect(
      hiddenFields(state, ["in", "out", "guests", "flex"]).map(([k]) => k),
    ).toEqual(["sort"]);
  });
  test("a chip says it, and removing it keeps the dates", () => {
    const chip = activeChips(state).find((c) => c.key === "flex");
    expect(chip.label).toBe("Available ±3 days");
    expect(chip.href).toContain(`in=${IN}`);
    expect(chip.href).not.toContain("flex");
  });
  test("removing the dates chip removes flex too", () => {
    const dates = activeChips(state).find((c) => c.key === "dates");
    expect(dates.href).not.toContain("flex");
    expect(dates.href).not.toContain("in=");
  });
  test("no chip without flex", () => {
    expect(
      activeChips({ in: IN, out: OUT }).some((c) => c.key === "flex"),
    ).toBe(false);
  });
});

describe("the page", () => {
  test("the toggle is in the search form, unchecked by default, with its help text", async () => {
    stubListingSearch(docs(2));
    const res = await get("/listings");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(
      /<input[^>]*type="checkbox"[^>]*name="flex"[^>]*value="3"[^>]*id="flex"/,
    );
    expect(res.text).not.toMatch(/id="flex"[^>]*checked/);
    expect(res.text).toContain("Available ±3 days");
    expect(res.text).toContain('id="flex-help"');
  });

  test("with flex=3 and dates it is checked, the results come from the flexible query, and links keep it", async () => {
    stubListingSearch(docs(2));
    flexible.mockResolvedValue([]);
    const res = await get(
      `/listings?in=${IN}&out=${OUT}&guests=2&flex=3&sort=price_asc`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/id="flex"[^>]*checked/);
    expect(flexible).toHaveBeenCalledTimes(1);
    expect(strict).not.toHaveBeenCalled();
    expect(res.text).toContain("Available ±3 days"); // the chip too
    const links = [...res.text.matchAll(/href="(\/listings\?[^"]*)"/g)].map(
      (m) => decode(m[1]),
    );
    expect(links.some((l) => l.includes("flex=3"))).toBe(true);
  });

  test("the search form does not send flex twice (checkbox, not also a hidden field)", async () => {
    stubListingSearch(docs(1));
    const res = await get(`/listings?in=${IN}&out=${OUT}&flex=3`);
    const start = res.text.indexOf('aria-label="Search stays"');
    const form = res.text.slice(start, res.text.indexOf("</form>", start));
    expect((form.match(/name="flex"/g) || []).length).toBe(1);
  });

  test("a wrong value shows the message and the page still works", async () => {
    stubListingSearch(docs(1));
    const res = await get(`/listings?in=${IN}&out=${OUT}&flex=9`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      "Flexible dates can only be 3 days either side.",
    );
    expect(flexible).not.toHaveBeenCalled();
    expect(strict).toHaveBeenCalledTimes(1);
  });

  test("the map data uses the same filter", async () => {
    stubListingSearch(docs(1));
    flexible.mockResolvedValue([]);
    const res = await get(`/api/search/map?in=${IN}&out=${OUT}&flex=3`);
    expect(res.status).toBe(200);
    expect(flexible).toHaveBeenCalledTimes(1);
    expect(strict).not.toHaveBeenCalled();
  });
});
