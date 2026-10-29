// Search-engine facing pieces (P18-T05): canonical URLs, the robots.txt text,
// the sitemap, and which pages must not be indexed.
//
// Every absolute URL is made from the configured public address
// (APP_BASE_URL), never from the Host header of the request, so a forged
// header cannot put another site's address into a page or the sitemap.

// Pages that belong to one signed-in person, to staff, or to the machinery of
// the site. robots.txt asks crawlers to stay out of them and the page itself
// says "noindex" (robots.txt alone does not remove a page from a search engine).
const PRIVATE_PREFIXES = Object.freeze([
  "/account",
  "/admin",
  "/api",
  "/compare",
  "/conversations",
  "/host",
  "/login",
  "/notifications",
  "/reports",
  "/signup",
  "/trips",
  "/wishlists",
]);

// Pages under /listings that are not the public listing page.
const PRIVATE_LISTING_PATH =
  /^\/listings\/(new|[^/]+\/(checkout|edit|images)(\/|$))/;

// The most links a sitemap file may hold is 50,000; this is far below it and
// keeps the query small. A bigger site needs a sitemap index.
const SITEMAP_LIMIT = 5000;

const STATIC_PAGES = Object.freeze([
  "/",
  "/listings",
  "/about",
  "/privacy",
  "/terms",
]);

const trimSlash = (base) => String(base || "").replace(/\/+$/, "");

/** "https://dimora.example.com" + "/listings/1" -> one absolute URL. */
function absoluteUrl(base, pathname = "/") {
  const path = String(pathname).startsWith("/") ? pathname : `/${pathname}`;
  return `${trimSlash(base)}${path}`;
}

/** True for a path that must not be indexed (private, staff, or machinery). */
function isPrivatePath(pathname) {
  const path = String(pathname || "/");
  if (PRIVATE_LISTING_PATH.test(path)) return true;
  return PRIVATE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * The one URL a page is known by. The query string is dropped (dates, guests,
 * filters and sort all show the same stays), except `page` on the results
 * list, because page 2 is a different set of stays. A private page, and any
 * page that did not answer 200, has none.
 */
function canonicalUrl(base, { path = "/", query = {}, status = 200 } = {}) {
  if (status !== 200 || isPrivatePath(path)) return "";
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (clean === "/listings") {
    const page = Number.parseInt(
      Array.isArray(query.page) ? query.page[0] : query.page,
      10,
    );
    if (Number.isInteger(page) && page > 1 && page <= 10000) {
      return absoluteUrl(base, `/listings?page=${page}`);
    }
  }
  return absoluteUrl(base, clean);
}

/** The value of <meta name="robots">, or "" to say nothing (index, follow). */
function robotsMeta({ path = "/", status = 200 } = {}) {
  return status !== 200 || isPrivatePath(path) ? "noindex, nofollow" : "";
}

/** The text of /robots.txt. */
function robotsTxt(base) {
  const lines = ["User-agent: *"];
  for (const prefix of PRIVATE_PREFIXES) lines.push(`Disallow: ${prefix}/`);
  lines.push("Disallow: /listings/new");
  lines.push("Disallow: /listings/*/checkout");
  lines.push("Disallow: /listings/*/edit");
  lines.push("Disallow: /listings/*/images");
  lines.push("", `Sitemap: ${absoluteUrl(base, "/sitemap.xml")}`, "");
  return lines.join("\n");
}

const xmlEscape = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** "2026-10-29" from a Date (UTC), or "" for anything else. */
function lastmod(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * @param {string} base  the public address
 * @param {Array<{ _id: any, updatedAt?: Date }>} listings  public listings only
 * @returns {string} sitemap XML
 */
function sitemapXml(base, listings = []) {
  const rows = STATIC_PAGES.map((path) => ({ loc: absoluteUrl(base, path) }));
  for (const listing of listings.slice(
    0,
    SITEMAP_LIMIT - STATIC_PAGES.length,
  )) {
    if (!listing || !listing._id) continue;
    rows.push({
      loc: absoluteUrl(base, `/listings/${listing._id}`),
      lastmod: lastmod(listing.updatedAt),
    });
  }
  const body = rows
    .map(
      (row) =>
        `  <url><loc>${xmlEscape(row.loc)}</loc>${row.lastmod ? `<lastmod>${row.lastmod}</lastmod>` : ""}</url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

module.exports = {
  PRIVATE_PREFIXES,
  SITEMAP_LIMIT,
  STATIC_PAGES,
  absoluteUrl,
  isPrivatePath,
  canonicalUrl,
  robotsMeta,
  robotsTxt,
  sitemapXml,
};
