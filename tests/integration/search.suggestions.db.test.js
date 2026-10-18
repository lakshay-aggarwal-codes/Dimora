// P05-T05 against a real MongoDB: empty searches, and the promise that every
// suggestion on the page leads to a page with results. Needs a MongoDB (see
// tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createListing } = require("../helpers/factories");

const place = (city, state, country) => ({ address: { city, state, country }, location: `${city}, ${state}`, country });

async function seed() {
  await createListing({ title: "Goa villa", ...place("Panaji", "Goa", "India"), price: 6000, propertyType: "villa", amenities: ["wifi", "pool"], capacity: { guests: 8, bedrooms: 4, beds: 5, bathrooms: 3 } });
  await createListing({ title: "Goa room", ...place("Margao", "Goa", "India"), price: 900, propertyType: "apartment", amenities: ["wifi"], capacity: { guests: 2, bedrooms: 1, beds: 1, bathrooms: 1 } });
  await createListing({ title: "Manali cabin", ...place("Manali", "Himachal Pradesh", "India"), price: 3500, propertyType: "cabin", amenities: ["heating"], capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 } });
  await createListing({ title: "Paris flat", ...place("Paris", "Île-de-France", "France"), price: 12000, propertyType: "apartment", amenities: ["wifi"], capacity: { guests: 3, bedrooms: 1, beds: 2, bathrooms: 1 } });
  await createListing({ title: "Hidden draft", ...place("Panaji", "Goa", "India"), status: "draft", price: 1000 });
}

const decode = (s) => s.replace(/&amp;/g, "&");
const suggestionLinks = (html) => [...html.matchAll(/<a href="([^"]+)">[^<]*<\/a>\s*<span class="suggestion-count">/g)].map((m) => decode(m[1]));
const stays = (html) => (html.match(/class="card h-100 listing-card"/g) || []).length;

const EMPTY_SEARCHES = [
  "/listings?dest=Panaji&guests=9",
  "/listings?dest=Manali&type=villa",
  "/listings?amenities=pool&maxPrice=900",
  "/listings?dest=Paris&guests=5&minPrice=100",
  "/listings?dest=Goa&amenities=heating",
  "/listings?keywords=pool&roomType=shared_room",
  "/listings?guests=15",
  "/listings?dest=Nowhere",
];

describeDb("suggestions for empty searches", () => {
  useTestDb();
  beforeEach(seed);

  test.each(EMPTY_SEARCHES)("%s: it is empty, and every suggestion on it has results", async (url) => {
    const agent = createAgent();
    const page = await agent.get(url);
    expect(page.status).toBe(200);
    expect(stays(page.text)).toBe(0);
    const offered = suggestionLinks(page.text);
    for (const link of offered) {
      const next = await agent.get(link);
      expect(next.status).toBe(200);
      expect({ link, stays: stays(next.text) > 0 }).toEqual({ link, stays: true });
    }
  });

  test("a search where the destination is the problem offers popular destinations only", async () => {
    const page = await createAgent().get("/listings?dest=Nowhere");
    expect(page.text).toContain("Popular destinations");
    expect(page.text).toContain('href="/listings?dest=Panaji"');
    expect(page.text).not.toContain("Try this instead");
  });

  test("the filter that removes most is offered first, with how many stays it gives", async () => {
    const page = await createAgent().get("/listings?dest=Panaji&guests=9");
    const first = /Try this instead[\s\S]*?<a href="([^"]+)">([^<]*)<\/a>\s*<span class="suggestion-count">([^<]*)</.exec(page.text);
    expect(first[2]).toBe("Remove the guest count (9 guests)");
    expect(first[3].trim()).toBe("1 stay"); // Panaji has one public listing (the draft does not count)
  });

  test("drafts never show up in the numbers or the destinations", async () => {
    const page = await createAgent().get("/listings?dest=Panaji&guests=9");
    expect(page.text).not.toContain("Hidden draft");
    expect(page.text).toMatch(/Panaji<\/a>\s*<span class="suggestion-count">1 stay</);
  });

  test("with results there are no suggestions", async () => {
    const page = await createAgent().get("/listings?dest=Goa");
    expect(page.text).not.toContain("Try this instead");
    expect(stays(page.text)).toBe(2);
  });
});
