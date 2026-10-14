// Only same-site paths may be used as a post-login destination. Anything that a
// browser could read as another host (//evil.com, /\evil.com, https://...,
// javascript:, control characters) is refused.
const BASE = "http://dimora.invalid";
const MAX_LENGTH = 2048;
// The auth pages themselves: going back to them after login would be a loop.
const AUTH_PATHS = new Set(["/login", "/signup", "/logout"]);

/**
 * Returns `value` when it is a safe local path, otherwise `fallback`.
 * Never throws.
 */
function safeRedirectPath(value, fallback = "/") {
  if (typeof value !== "string") return fallback;
  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;
  // Must be an absolute path on this site: one leading slash, not two, and
  // no backslash (browsers treat "\" like "/").
  if (value[0] !== "/" || value[1] === "/" || value[1] === "\\")
    return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  let url;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  // "/..//evil.com" stays on this site in a browser, but its normalised path
  // starts with "//", which some code would pass on as a network-path reference.
  if (url.pathname.startsWith("//")) return fallback;
  if (AUTH_PATHS.has(url.pathname.replace(/\/+$/, "") || "/")) return fallback;
  return value;
}

module.exports = { safeRedirectPath };
