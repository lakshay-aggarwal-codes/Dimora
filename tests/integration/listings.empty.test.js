// P05-T05 through the real page, without a database: the model and the ledger
// are stubbed so the test controls what each query returns.
const { createAgent } = require("../helpers/agent");
const Listing = require("../../src/models/listing");
const ledger = require("../../src/services/ledger");

afterEach(() => jest.restoreAllMocks());

// countDocuments answers by a function of the filter; find() is the page's own
// (empty) list, or the destinations query when it is the public one with select().
function stub({ count, destinations = [] }) {
  jest.spyOn(ledger, "unavailableListingIds").mockResolvedValue([]);
  const counts = jest.spyOn(Listing, "countDocuments").mockImplementation(async (filter) => count(filter));
  const finds = jest.spyOn(Listing, "find").mockImplementation(() => {
    const chain = {
      sort: () => chain,
      skip: () => chain,
      limit: () => chain,
      select: () => chain,
      lean: () => chain,
      then: (resolve, reject) => Promise.resolve(destinations).then(resolve, reject),
    };
    return chain;
  });
  return { counts, finds };
}

const hasGuests = (f) => Object.hasOwn(f, "capacity.guests");
const get = (url) => createAgent().get(url);
const links = (html, heading) => {
  const start = html.indexOf(heading);
  if (start === -1) return [];
  const rest = html.slice(start);
  const end = rest.indexOf("</ul>");
  return [...rest.slice(0, end).matchAll(/<a href="([^"]+)">([^<]*)<\/a>\s*<span class="suggestion-count">([^<]*)</g)].map((m) => ({
    href: m[1].replace(/&amp;/g, "&"),
    text: m[2],
    count: m[3].trim(),
  }));
};

test("an empty filtered search offers the filter whose removal gives stays, with the number", async () => {
  stub({ count: (f) => (hasGuests(f) ? 0 : 7) });
  const res = await get("/listings?dest=Goa&guests=9");
  expect(res.status).toBe(200);
  expect(res.text).toContain("No stays match your search");
  expect(res.text).toContain("Try this instead");
  const [first] = links(res.text, "Try this instead");
  expect(first.text).toBe("Remove the guest count (9 guests)");
  expect(first.count).toBe("7 stays");
  expect(first.href).toBe("/listings?dest=Goa");
});

test("a removal that still gives zero is not offered", async () => {
  stub({ count: () => 0 });
  const res = await get("/listings?dest=Goa&guests=9");
  expect(res.text).not.toContain("Try this instead");
  expect(res.text).not.toContain("suggestion-count");
});

test("popular destinations are offered with a link that carries no other filter", async () => {
  stub({
    count: () => 0,
    destinations: [
      { cityKey: "panaji", address: { city: "Panaji" } },
      { cityKey: "panaji", address: { city: "Panaji" } },
      { cityKey: "manali", address: { city: "Manali" } },
    ],
  });
  const res = await get("/listings?dest=Nowhere&guests=2&minPrice=500");
  const places = links(res.text, "Popular destinations");
  expect(places.map((p) => [p.text, p.count, p.href])).toEqual([
    ["Panaji", "2 stays", "/listings?dest=Panaji"],
    ["Manali", "1 stay", "/listings?dest=Manali"],
  ]);
  expect(res.text).toContain("Clear all filters");
});

test("with no stays at all there is no 'clear filters' and the host is invited to list a place", async () => {
  stub({ count: () => 0, destinations: [] });
  const res = await get("/listings?dest=Nowhere");
  expect(res.text).not.toContain("Clear all filters");
  expect(res.text).toContain("List your place");
  expect(res.text).not.toContain("Popular destinations");
});

test("text in suggestions is escaped", async () => {
  stub({
    count: () => 3,
    destinations: [{ cityKey: "x", address: { city: "<script>alert(1)</script>" } }],
  });
  const res = await get('/listings?keywords=%3Cb%3Ehi%3C%2Fb%3E&guests=2');
  expect(res.text).not.toContain("<script>alert(1)");
  expect(res.text).not.toContain("<b>hi</b>");
});

test("a search that has results gets no suggestions and no extra queries", async () => {
  const { counts, finds } = stub({ count: () => 5 });
  const res = await get("/listings?dest=Goa");
  expect(res.text).not.toContain("Try this instead");
  expect(counts).toHaveBeenCalledTimes(1); // only the page's own count
  expect(finds).toHaveBeenCalledTimes(1); // only the page's own list
});

test("an empty site with no filters is 'No stays yet', with no suggestions", async () => {
  const { counts } = stub({ count: () => 0 });
  const res = await get("/listings");
  expect(res.text).toContain("No stays yet");
  expect(res.text).not.toContain("Try this instead");
  expect(res.text).not.toContain("Popular destinations");
  expect(counts).toHaveBeenCalledTimes(1);
});

test("an empty search costs at most five more queries", async () => {
  const { counts, finds } = stub({ count: () => 0 });
  await get("/listings?dest=Goa&guests=2&minPrice=100&maxPrice=900&type=villa&amenities=wifi&instantBook=1&bedrooms=2");
  // the page's own count and list, plus at most 4 counts and 1 destinations lookup
  expect(counts.mock.calls.length + finds.mock.calls.length).toBeLessThanOrEqual(2 + 5);
});
