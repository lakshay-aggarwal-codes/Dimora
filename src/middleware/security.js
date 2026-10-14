// Security baseline (P01-T09): per-request CSP nonce, helmet headers, and rate
// limits for the login and signup forms.
const crypto = require("node:crypto");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { AppError } = require("../utils/errors");

/** A fresh nonce per request; views put it on every inline <script>/<style>. */
function assignCspNonce(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
}

const nonce = (req, res) => `'nonce-${res.locals.cspNonce}'`;

// Third-party hosts the pages load from (see views/layouts/boilerPlate.ejs).
const JSDELIVR = "https://cdn.jsdelivr.net"; // Bootstrap CSS/JS
const CDNJS = "https://cdnjs.cloudflare.com"; // Font Awesome
const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com";
const MAPBOX = "https://api.mapbox.com";
const MAPBOX_TILES = "https://*.tiles.mapbox.com";
const MAPBOX_EVENTS = "https://events.mapbox.com";
const CLOUDINARY = "https://res.cloudinary.com";
const UNSPLASH = "https://images.unsplash.com"; // seed data pictures

/**
 * helmet with a CSP that allows only this site, the CDNs above, Mapbox and
 * Cloudinary. Inline <script>/<style> blocks need the request's nonce. Inline
 * style="" attributes are still allowed (style-src-attr): Mapbox GL and a few
 * views use them; scripts get no such exception.
 */
function securityHeaders({ isProduction = false } = {}) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", nonce, JSDELIVR, MAPBOX],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", nonce, JSDELIVR, CDNJS, GOOGLE_FONTS_CSS, MAPBOX],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'", GOOGLE_FONTS_FILES, CDNJS, "data:"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          CLOUDINARY,
          UNSPLASH,
          MAPBOX,
          MAPBOX_TILES,
        ],
        connectSrc: ["'self'", MAPBOX, MAPBOX_TILES, MAPBOX_EVENTS],
        workerSrc: ["'self'", "blob:"],
        childSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        // Only meaningful (and safe) behind HTTPS.
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    // The Mapbox public token can be restricted by URL, which needs a Referer.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    strictTransportSecurity: isProduction ? undefined : false,
  });
}

function tooManyAttempts(req, res, next) {
  next(
    new AppError(
      429,
      "Too many attempts. Please wait a few minutes and try again.",
      { code: "rate_limited" },
    ),
  );
}

/**
 * Created per app (not at module load) so every test app starts with empty
 * counters. Login: 5 failed attempts per 15 minutes per IP (a successful
 * login is not counted). Signup: 10 per hour per IP.
 */
function createAuthLimiters() {
  const common = {
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooManyAttempts,
  };
  return {
    login: rateLimit({
      ...common,
      windowMs: 15 * 60 * 1000,
      limit: 5,
      skipSuccessfulRequests: true,
      // passport redirects both ways, so "success" means "now logged in".
      requestWasSuccessful: (req) => Boolean(req.user),
    }),
    signup: rateLimit({ ...common, windowMs: 60 * 60 * 1000, limit: 10 }),
  };
}

module.exports = { assignCspNonce, securityHeaders, createAuthLimiters };
