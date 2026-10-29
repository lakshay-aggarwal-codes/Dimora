// What a request log may say about a URL (P17-T05): the path, never the query
// string, and never a one-time token that travels in the path
// (/verify-email/<token>, /reset-password/<token>; P02-T05). A reset link in a
// log is a key to the account for as long as the link lives.
const TOKEN_ROUTES = /^(\/(?:verify-email|reset-password)\/)[^/]+/;

/** @param {string|undefined} url the raw request URL (path and query) */
function redactPath(url) {
  const path = String(url || "").split("?")[0].split("#")[0];
  return path.replace(TOKEN_ROUTES, "$1[redacted]");
}

module.exports = { redactPath };
