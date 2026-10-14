// CSRF protection (P01-T10, ADR-006): a synchronizer token kept in the session.
//
// - Each session gets one random token (`req.session.csrfToken`). It is exposed
//   to views as `res.locals.csrfToken` (hidden field, <meta> tag, query string).
// - Every request that is not GET/HEAD/OPTIONS must send the same token in the
//   `X-CSRF-Token` header, the `_csrf` query parameter or the `_csrf` body field.
// - Must run AFTER the session and the urlencoded body parser, and BEFORE
//   multer and every router. Multipart forms cannot send the token in the body
//   (multer has not parsed it yet), so they put it in the query string.
// - The token is bound to the session. A new session (login and logout both
//   regenerate it) gets a new token; a form rendered before that is rejected
//   with the 403 page and the visitor is asked to reload.
//
// No package is used: csurf is deprecated and this is ~40 lines.
const crypto = require("node:crypto");
const { ForbiddenError } = require("../utils/errors");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HEADER = "x-csrf-token";
const FIELD = "_csrf";
const TOKEN_BYTES = 32;

const MESSAGE =
  "Your form has expired or could not be verified. Please reload the page and try again.";

/** The session's token, created on first use. Undefined if there is no session. */
function getToken(req) {
  if (!req.session) return undefined;
  if (typeof req.session.csrfToken !== "string") {
    req.session.csrfToken = crypto
      .randomBytes(TOKEN_BYTES)
      .toString("base64url");
  }
  return req.session.csrfToken;
}

/** Constant-time comparison; false for anything that is not a matching string. */
function tokensMatch(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string")
    return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Header, then query string, then body. Only strings count (no arrays). */
function submittedToken(req) {
  const fromHeader = req.get(HEADER);
  if (typeof fromHeader === "string" && fromHeader) return fromHeader;
  const fromQuery = req.query && req.query[FIELD];
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  const fromBody = req.body && req.body[FIELD];
  if (typeof fromBody === "string" && fromBody) return fromBody;
  return undefined;
}

function csrfProtection() {
  return function csrfProtectionMiddleware(req, res, next) {
    const expected = getToken(req);
    res.locals.csrfToken = expected || "";

    if (SAFE_METHODS.has(req.method)) return next();

    if (!expected || !tokensMatch(expected, submittedToken(req))) {
      if (req.log)
        req.log.warn({ event: "csrf_rejected" }, "csrf token rejected");
      return next(new ForbiddenError(MESSAGE, { code: "csrf_invalid" }));
    }

    // The field is not part of any form's data: validation schemas reject
    // unknown keys, so remove it once it has been checked.
    if (req.body && typeof req.body === "object") delete req.body[FIELD];
    next();
  };
}

module.exports = { csrfProtection, getToken, tokensMatch, SAFE_METHODS };
