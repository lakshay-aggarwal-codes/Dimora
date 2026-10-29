// P18-T05 through the real app and views, no database: robots.txt, the
// sitemap, canonical and Open Graph tags, and noindex on pages that are not
// for search engines. The address comes from the configuration, never from
// the request's Host header.
const { ObjectId } = require("mongoose").Types;
const { createAgent, createTestApp, login } = require("../helpers/agent");
const request = require("supertest");
const { testConfig } = require("../helpers/config");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const reviewService = require("../../src/services/reviews");
const User = require("../../src/models/user");

const BASE = "https://dimora.example.com";
const app = () =>
  createTestApp({ config: { ...testConfig(), appBaseUrl: BASE } });
const get = (url, headers = {}) => {
  const agent = request.agent(app());
  let req = agent.get(url);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req;
};
const tag = (html, re) => (html.match(re) || [])[1];

// passport is shared by every app a test file creates, so the user stubs are in
// place before the first one (like the other page tests).
const current = { user: null };
beforeEach(() => {
  current.user = null;
  jest
    .spyOn(User, "authenticate")
    .mockReturnValue((u, p, done) => done(null, current.user));
  jest
    .spyOn(User, "serializeUser")
    .mockReturnValue((u, done) => done(null, String(u._id)));
  jest
    .spyOn(User, "deserializeUser")
    .mockReturnValue((id, done) => done(null, current.user));
});
afterEach(() => jest.restoreAllMocks());

describe("/robots.txt", () => {
  test("plain text, cached, disallows admin and API, names the sitemap", async () => {
    const res = await get("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.text).toContain("Disallow: /admin/");
    expect(res.text).toContain("Disallow: /api/");
    expect(res.text).toContain(`Sitemap: ${BASE}/sitemap.xml`);
  });

  test("a forged Host header changes nothing", async () => {
    const res = await get("/robots.txt", {
      Host: "evil.example.net",
      "X-Forwarded-Host": "evil.example.net",
    });
    expect(res.text).toContain(`${BASE}/sitemap.xml`);
    expect(res.text).not.toContain("evil.example.net");
  });
});

describe("/sitemap.xml", () => {
  function stubFind(rows) {
    const chain = {
      select: jest.fn(() => chain),
      sort: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      lean: jest.fn(() => Promise.resolve(rows)),
    };
    const find = jest.spyOn(Listing, "find").mockReturnValue(chain);
    return { find, chain };
  }

  test("asks only for published, not deleted listings, and only their id and date", async () => {
    const id = String(new ObjectId());
    const { find, chain } = stubFind([
      { _id: id, updatedAt: new Date("2026-10-01T00:00:00Z") },
    ]);
    const res = await get("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledWith({ status: "published", deletedAt: null });
    expect(chain.select).toHaveBeenCalledWith("_id updatedAt");
    expect(chain.limit).toHaveBeenCalledWith(5000);
    expect(res.headers["content-type"]).toMatch(/^application\/xml/);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.text).toContain(
      `<loc>${BASE}/listings/${id}</loc><lastmod>2026-10-01</lastmod>`,
    );
    expect(res.text).toContain(`<loc>${BASE}/about</loc>`);
  });

  test("a database error is the normal error page, not a half sitemap", async () => {
    const chain = {
      select: () => chain,
      sort: () => chain,
      limit: () => chain,
      lean: () => Promise.reject(new Error("db down")),
    };
    jest.spyOn(Listing, "find").mockReturnValue(chain);
    const res = await get("/sitemap.xml");
    expect(res.status).toBe(500);
    expect(res.text).not.toContain("<urlset");
  });

  test("a forged Host header changes nothing", async () => {
    stubFind([{ _id: String(new ObjectId()) }]);
    const res = await get("/sitemap.xml", { Host: "evil.example.net" });
    expect(res.text).not.toContain("evil.example.net");
    expect(res.text).toContain(BASE);
  });
});

describe("canonical, robots and Open Graph tags in the layout", () => {
  test("a static page has a canonical link and Open Graph tags without an image", async () => {
    const { text } = await get("/about");
    expect(tag(text, /<link rel="canonical" href="([^"]*)">/)).toBe(
      `${BASE}/about`,
    );
    expect(tag(text, /<meta property="og:url" content="([^"]*)">/)).toBe(
      `${BASE}/about`,
    );
    expect(tag(text, /<meta property="og:site_name" content="([^"]*)">/)).toBe(
      "Dimora",
    );
    expect(tag(text, /<meta property="og:type" content="([^"]*)">/)).toBe(
      "website",
    );
    expect(tag(text, /<meta property="og:title" content="([^"]*)">/)).toMatch(
      /\| Dimora$/,
    );
    expect(
      tag(text, /<meta property="og:description" content="([^"]*)">/),
    ).toBeTruthy();
    expect(text).not.toContain('property="og:image"');
    expect(tag(text, /<meta name="twitter:card" content="([^"]*)">/)).toBe(
      "summary",
    );
    expect(text).not.toContain('<meta name="robots"');
  });

  test("a query string never makes another canonical address", async () => {
    const { text } = await get("/about?utm_source=x&dest=Goa");
    expect(tag(text, /<link rel="canonical" href="([^"]*)">/)).toBe(
      `${BASE}/about`,
    );
  });

  test("a private page asks not to be indexed and has no canonical or Open Graph tags", async () => {
    const { text, status } = await get("/login");
    expect(status).toBe(200);
    expect(tag(text, /<meta name="robots" content="([^"]*)">/)).toBe(
      "noindex, nofollow",
    );
    expect(text).not.toContain('rel="canonical"');
    expect(text).not.toContain('property="og:');
  });

  test("a page that does not exist is not indexed and has no canonical link", async () => {
    const res = await get("/no-such-page");
    expect(res.status).toBe(404);
    expect(tag(res.text, /<meta name="robots" content="([^"]*)">/)).toBe(
      "noindex, nofollow",
    );
    expect(res.text).not.toContain('rel="canonical"');
  });

  test("a forged Host header does not reach the canonical link", async () => {
    const { text } = await get("/about", { Host: "evil.example.net" });
    expect(text).not.toContain("evil.example.net");
  });
});

describe("the listing page", () => {
  function stub(doc) {
    jest.spyOn(reviewService, "findReviewable").mockResolvedValue(null);
    const query = {
      populate: () => query,
      then: (res, rej) => Promise.resolve(doc).then(res, rej),
    };
    jest.spyOn(Listing, "findById").mockReturnValue(query);
  }
  const open = async (extra, url = (d) => `/listings/${d._id}`) => {
    const doc = new Listing(
      buildListingData({
        owner: new ObjectId(),
        title: "Seaside Cottage",
        ...extra,
      }),
    );
    stub(doc);
    const res = await createAgent({
      config: { ...testConfig(), appBaseUrl: BASE },
    }).get(url(doc));
    return { res, doc };
  };

  test("canonical without the date and guest query, and the title and description as Open Graph", async () => {
    const { res, doc } = await open(
      { description: "A quiet cottage by the sea." },
      (d) => `/listings/${d._id}?in=2026-12-24&out=2026-12-27&guests=2`,
    );
    expect(res.status).toBe(200);
    expect(tag(res.text, /<link rel="canonical" href="([^"]*)">/)).toBe(
      `${BASE}/listings/${doc._id}`,
    );
    expect(tag(res.text, /<meta property="og:title" content="([^"]*)">/)).toBe(
      "Seaside Cottage | Dimora",
    );
    expect(
      tag(res.text, /<meta property="og:description" content="([^"]*)">/),
    ).toBe("A quiet cottage by the sea.");
  });

  test("the first photo, large, is the Open Graph image and the card is the big one", async () => {
    const { res } = await open({
      image: {
        url: "https://res.cloudinary.com/demo/image/upload/v1/a.jpg",
        filename: "a",
      },
    });
    const image = tag(res.text, /<meta property="og:image" content="([^"]*)">/);
    expect(image).toBe(
      "https://res.cloudinary.com/demo/image/upload/w_1600,f_auto,q_auto/v1/a.jpg",
    );
    expect(tag(res.text, /<meta name="twitter:card" content="([^"]*)">/)).toBe(
      "summary_large_image",
    );
  });

  test("a photo that is not https is never used", async () => {
    const { res } = await open({
      image: { url: "http://example.com/a.jpg", filename: "a" },
    });
    expect(res.text).not.toContain('property="og:image"');
  });

  test("a title with markup cannot break out of the tags", async () => {
    const { res } = await open({ title: '"><script>alert(1)</script>' });
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).not.toMatch(/og:title" content="[^"]*"><script/);
  });

  test("a draft seen by its host has no canonical link, no Open Graph tags and is not indexed", async () => {
    // Anyone but the host gets a 404 for a draft, so the host is signed in.
    const owner = new User({ username: "host", email: "host@example.com" });
    current.user = owner;
    const doc = new Listing(
      buildListingData({ owner: owner._id, status: "draft" }),
    );
    stub(doc);
    const agent = createAgent({
      config: { ...testConfig(), appBaseUrl: BASE },
    });
    await login(agent, { username: "host", password: "irrelevant-password" });
    const res = await agent.get(`/listings/${doc._id}`);
    expect(res.status).toBe(200);
    expect(tag(res.text, /<meta name="robots" content="([^"]*)">/)).toBe(
      "noindex, nofollow",
    );
    expect(res.text).not.toContain('rel="canonical"');
    expect(res.text).not.toContain('property="og:');
  });
});
