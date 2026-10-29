// P18-T05: canonical URLs, robots.txt, the sitemap and what is not indexed.
const {
  PRIVATE_PREFIXES,
  SITEMAP_LIMIT,
  STATIC_PAGES,
  absoluteUrl,
  isPrivatePath,
  canonicalUrl,
  robotsMeta,
  robotsTxt,
  sitemapXml,
} = require("../../src/utils/seo");

const BASE = "https://dimora.example.com";

describe("absoluteUrl", () => {
  test("joins the address and a path with exactly one slash", () => {
    expect(absoluteUrl(BASE, "/about")).toBe(`${BASE}/about`);
    expect(absoluteUrl(`${BASE}/`, "/about")).toBe(`${BASE}/about`);
    expect(absoluteUrl(`${BASE}//`, "about")).toBe(`${BASE}/about`);
    expect(absoluteUrl(BASE)).toBe(`${BASE}/`);
  });
});

describe("isPrivatePath", () => {
  test.each([
    "/admin",
    "/admin/users",
    "/api/listings/1/quote",
    "/host/reservations",
    "/trips/5",
    "/account/password",
    "/wishlists",
    "/compare",
    "/login",
    "/signup",
    "/reports/new",
    "/listings/new",
    "/listings/64b0f0f0f0f0f0f0f0f0aaaa/checkout",
    "/listings/64b0f0f0f0f0f0f0f0f0aaaa/edit",
    "/listings/64b0f0f0f0f0f0f0f0f0aaaa/images/x",
  ])("%s is private", (path) => {
    expect(isPrivatePath(path)).toBe(true);
  });

  test.each([
    "/",
    "/listings",
    "/listings/64b0f0f0f0f0f0f0f0f0aaaa",
    "/about",
    "/privacy",
    "/terms",
    "/users/64b0f0f0f0f0f0f0f0f0aaaa",
    "/administrators", // starts with the letters, not a path below /admin
    "/apiary",
  ])("%s is public", (path) => {
    expect(isPrivatePath(path)).toBe(false);
  });
});

describe("canonicalUrl", () => {
  test("a public page is known by its path alone", () => {
    expect(canonicalUrl(BASE, { path: "/about" })).toBe(`${BASE}/about`);
    expect(canonicalUrl(BASE, { path: "/" })).toBe(`${BASE}/`);
    expect(canonicalUrl(BASE, { path: "/about/" })).toBe(`${BASE}/about`);
  });

  test("the query string never makes a different page, except the results page number", () => {
    const id = "64b0f0f0f0f0f0f0f0f0aaaa";
    expect(
      canonicalUrl(BASE, {
        path: `/listings/${id}`,
        query: { in: "2026-12-24", guests: "2" },
      }),
    ).toBe(`${BASE}/listings/${id}`);
    expect(
      canonicalUrl(BASE, {
        path: "/listings",
        query: { dest: "Goa", sort: "price" },
      }),
    ).toBe(`${BASE}/listings`);
    expect(
      canonicalUrl(BASE, {
        path: "/listings",
        query: { dest: "Goa", page: "3" },
      }),
    ).toBe(`${BASE}/listings?page=3`);
  });

  test("page 1, a nonsense page and a hostile one all mean /listings", () => {
    for (const page of [
      "1",
      "0",
      "-2",
      "abc",
      "2.5x",
      "99999999",
      ["x"],
      { $gt: "" },
      undefined,
    ]) {
      expect(canonicalUrl(BASE, { path: "/listings", query: { page } })).toBe(
        page === "2.5x" ? `${BASE}/listings?page=2` : `${BASE}/listings`,
      );
    }
  });

  test("a private page and any answer that is not 200 have none", () => {
    expect(canonicalUrl(BASE, { path: "/trips" })).toBe("");
    expect(canonicalUrl(BASE, { path: "/about", status: 404 })).toBe("");
    expect(canonicalUrl(BASE, { path: "/about", status: 500 })).toBe("");
  });

  test("uses only the configured address, so the request cannot change it", () => {
    const url = canonicalUrl(BASE, { path: "/about" });
    expect(url.startsWith(BASE)).toBe(true);
  });
});

describe("robotsMeta", () => {
  test("says nothing for a public page that worked", () => {
    expect(robotsMeta({ path: "/about" })).toBe("");
  });
  test("noindex for private pages and for errors", () => {
    expect(robotsMeta({ path: "/login" })).toBe("noindex, nofollow");
    expect(robotsMeta({ path: "/about", status: 404 })).toBe(
      "noindex, nofollow",
    );
  });
});

describe("robotsTxt", () => {
  const text = robotsTxt(BASE);
  const lines = text.split("\n");

  test("one group for everyone, the sitemap by absolute address, and a final newline", () => {
    expect(lines[0]).toBe("User-agent: *");
    expect(lines).toContain(`Sitemap: ${BASE}/sitemap.xml`);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("keeps crawlers out of the admin area and the API (the card's minimum)", () => {
    expect(lines).toContain("Disallow: /admin/");
    expect(lines).toContain("Disallow: /api/");
  });

  test("lists every private prefix and the listing pages that are not public", () => {
    for (const prefix of PRIVATE_PREFIXES)
      expect(lines).toContain(`Disallow: ${prefix}/`);
    for (const path of [
      "/listings/new",
      "/listings/*/checkout",
      "/listings/*/edit",
      "/listings/*/images",
    ]) {
      expect(lines).toContain(`Disallow: ${path}`);
    }
  });

  test("does not block the public pages or the listing pages", () => {
    expect(lines).not.toContain("Disallow: /");
    expect(lines).not.toContain("Disallow: /listings/");
    expect(lines).not.toContain("Disallow: /listings");
    expect(text).not.toMatch(/Disallow:\s*$/m);
  });
});

describe("sitemapXml", () => {
  const id = "64b0f0f0f0f0f0f0f0f0aaaa";

  test("the public pages first, then one entry per listing with its last change", () => {
    const xml = sitemapXml(BASE, [
      { _id: id, updatedAt: new Date("2026-10-20T23:30:00Z") },
    ]);
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ),
    ).toBe(true);
    for (const path of STATIC_PAGES)
      expect(xml).toContain(`<loc>${absoluteUrl(BASE, path)}</loc>`);
    expect(xml).toContain(
      `<url><loc>${BASE}/listings/${id}</loc><lastmod>2026-10-20</lastmod></url>`,
    );
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  test("a listing with no usable date has no lastmod; one with no id is left out", () => {
    const xml = sitemapXml(BASE, [
      { _id: id },
      { _id: "64b0f0f0f0f0f0f0f0f0bbbb", updatedAt: "nonsense" },
      { updatedAt: new Date() },
      null,
    ]);
    expect(xml).toContain(`<url><loc>${BASE}/listings/${id}</loc></url>`);
    expect(xml).toContain(
      `<url><loc>${BASE}/listings/64b0f0f0f0f0f0f0f0f0bbbb</loc></url>`,
    );
    expect((xml.match(/<url>/g) || []).length).toBe(STATIC_PAGES.length + 2);
  });

  test("an address with special characters is escaped, so the XML stays valid", () => {
    const xml = sitemapXml("https://x.example/?a=1&b=<2>", []);
    expect(xml).toContain("&amp;");
    expect(xml).not.toMatch(/<loc>[^<]*[<>&](?!amp;|lt;|gt;)[^<]*<\/loc>/);
    expect(xml).not.toContain("<2>");
  });

  test("never holds more than the limit, and has no titles or host text", () => {
    const many = Array.from({ length: SITEMAP_LIMIT + 50 }, (_, i) => ({
      _id: String(i).padStart(24, "0"),
      title: "SECRET TITLE",
    }));
    const xml = sitemapXml(BASE, many);
    expect((xml.match(/<url>/g) || []).length).toBe(SITEMAP_LIMIT);
    expect(xml).not.toContain("SECRET TITLE");
  });
});
