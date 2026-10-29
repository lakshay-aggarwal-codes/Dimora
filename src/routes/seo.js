// /robots.txt and /sitemap.xml (P18-T05). Mounted before the session and CSRF
// middleware (like the health checks): a crawler gets no cookie, and the
// answers are cached for an hour.
//
//   GET /robots.txt   what crawlers may not visit, and where the sitemap is
//   GET /sitemap.xml  the public pages and every published, not deleted listing
//
// The sitemap holds ids and last-change dates only, never titles or anything a
// host wrote.
const express = require("express");
const { publicListingFilter } = require("../utils/visibility");
const { robotsTxt, sitemapXml, SITEMAP_LIMIT } = require("../utils/seo");

const CACHE = "public, max-age=3600";

/**
 * @param {object} options
 * @param {string} options.baseUrl  the public address (APP_BASE_URL)
 * @param {object} [options.Listing]  the model (tests pass a stand-in)
 */
function createSeoRouter({
  baseUrl,
  Listing = require("../models/listing"),
} = {}) {
  const router = express.Router();

  router.get("/robots.txt", (req, res) => {
    res.set("Cache-Control", CACHE).type("text/plain").send(robotsTxt(baseUrl));
  });

  router.get("/sitemap.xml", async (req, res, next) => {
    try {
      const listings = await Listing.find(publicListingFilter())
        .select("_id updatedAt")
        .sort({ _id: 1 })
        .limit(SITEMAP_LIMIT)
        .lean();
      res
        .set("Cache-Control", CACHE)
        .type("application/xml")
        .send(sitemapXml(baseUrl, listings));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSeoRouter };
