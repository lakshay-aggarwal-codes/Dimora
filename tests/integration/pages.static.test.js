// P01-T07 (D-08) + P03-T05: home page, static pages, navbar when logged out.
// Real app and views; the database is stubbed.
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");

afterEach(() => jest.restoreAllMocks());

function stubHomeListings(docs) {
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    lean: () => query,
    then: (resolve, reject) => Promise.resolve(docs).then(resolve, reject),
  };
  return jest.spyOn(Listing, "find").mockReturnValue(query);
}

describe("home page", () => {
  test("GET / is the home page (no redirect) with the hero search", async () => {
    stubHomeListings([]);
    const res = await createAgent().get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<h1");
    expect(res.text).toContain('action="/listings" method="GET" role="search"');
    for (const name of ["search", "checkIn", "checkOut", "guests"]) {
      expect(res.text).toContain(`name="${name}"`);
    }
    expect(res.text).toMatch(/<label for="hero-check-in"[^>]*>Check in/);
    expect(res.text).toContain("<title>Find a place to stay | Dimora</title>");
  });

  test("it carries the college-project notice and the how-it-works steps", async () => {
    stubHomeListings([]);
    const res = await createAgent().get("/");
    expect(res.text).toContain("Dimora is a college project.");
    expect(res.text).toContain("<ol class=\"how-steps\">");
    expect(res.text).toContain("No surprise costs");
  });

  test("with no listings it shows an empty state, not an empty grid or destinations", async () => {
    stubHomeListings([]);
    const res = await createAgent().get("/");
    expect(res.text).toContain("No stays yet");
    expect(res.text).toContain('href="/host/listings/new"');
    expect(res.text).not.toContain("listing-card");
    expect(res.text).not.toContain("Popular destinations");
  });

  test("featured stays are cards (max 6) and destinations link to the listings search", async () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({
      _id: `64b0000000000000000000${String(10 + i)}`,
      ...buildListingData({
        title: `Stay ${i}`,
        location: i < 5 ? "Goa" : "Manali",
        country: "India",
        price: 3000,
      }),
    }));
    stubHomeListings(docs);
    const res = await createAgent().get("/");
    expect(res.status).toBe(200);
    expect(res.text.match(/class="card h-100 listing-card"/g)).toHaveLength(6);
    expect(res.text).toContain("₹3,000");
    expect(res.text).toContain("Popular destinations");
    expect(res.text).toContain('href="/listings?search=Goa"');
    expect(res.text).toContain("5 stays");
    expect(res.text).toContain('href="/listings?search=Manali"');
  });

  test("text from listings is escaped; a listing with no price or image still renders", async () => {
    stubHomeListings([
      {
        _id: "64b000000000000000000001",
        title: "<script>alert(1)</script>",
        location: '"><img src=x onerror=alert(1)>',
      },
    ]);
    const res = await createAgent().get("/");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>alert(1)");
    expect(res.text).not.toContain("<img src=x");
    expect(res.text).toContain("Price not set");
    expect(res.text).not.toMatch(/style="/);
  });

  test("a database failure shows the error page, not a half-rendered home page", async () => {
    jest.spyOn(Listing, "find").mockImplementation(() => {
      throw new Error("db down");
    });
    const res = await createAgent().get("/");
    expect(res.status).toBe(500);
    expect(res.text).not.toContain("hero-search");
  });
});

describe("static pages", () => {
  test.each([
    ["/about", "About Dimora"],
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Service"],
  ])("%s is a real page marked as a college project", async (url, heading) => {
    const res = await createAgent().get(url);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<h1>${heading}</h1>`);
    expect(res.text).toContain("Dimora is a college project.");
    expect(res.text).toContain("no real money moves");
    expect(res.text).not.toContain("not written yet");
    expect(res.text).toContain(`<title>${heading} | Dimora</title>`);
  });

  test("the privacy page names what is stored and the outside services", async () => {
    const { text } = await createAgent().get("/privacy");
    for (const word of ["hashed", "Mapbox", "Cloudinary", "Google Fonts"]) {
      expect(text).toContain(word);
    }
  });

  test("external links open safely", async () => {
    const { text } = await createAgent().get("/about");
    expect(text).toMatch(/<a href="https:\/\/github\.com[^"]*" rel="noopener noreferrer">/);
  });
});

describe("links in the navbar and footer", () => {
  test("every internal link on the home page resolves (no 404)", async () => {
    stubHomeListings([]);
    const agent = createAgent();
    const home = await agent.get("/");
    const hrefs = new Set(
      [...home.text.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]),
    );
    const skip = (h) => h.startsWith("/css/") || h.startsWith("/js/");
    for (const href of hrefs) {
      if (skip(href)) continue;
      const res = await agent.get(href);
      // /listings/new sends a visitor to /login (302); nothing may be a 404.
      expect({ href, status: res.status === 404 ? 404 : "ok" }).toEqual({
        href,
        status: "ok",
      });
    }
    expect(hrefs.has("/about")).toBe(true);
  });
});

test("the navbar for a visitor links to Sign Up and Login, with clean hrefs", async () => {
  const res = await createAgent().get("/login");
  expect(res.status).toBe(200);
  expect(res.text).toContain('href="/signup"');
  expect(res.text).not.toContain('href="/signup "');
  expect(res.text).toContain('href="/login"');
  expect(res.text).not.toContain("Logout");
  expect(res.text).not.toContain("Login out");
});

test("the login-required message is not specific to creating a listing", async () => {
  const agent = createAgent();
  await agent.get("/listings/new");
  const res = await agent.get("/login");
  expect(res.text).toContain("You must be logged in to do that");
  expect(res.text).not.toContain("create new listing");
});
