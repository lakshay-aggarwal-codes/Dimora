// Small pure helpers for scripts/seed-demo.js (P19-T02): which database a URI
// points at, and where demo passwords come from. No database, no environment.
const crypto = require("node:crypto");

function hostsOf(uri) {
  const rest = String(uri).replace(/^mongodb(\+srv)?:\/\//i, "");
  const authority = rest.split(/[/?]/)[0];
  const hostList = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  return hostList
    .split(",")
    .map((host) => {
      const h = host.trim();
      const bracketed = h.match(/^\[(.*)\](?::\d+)?$/); // IPv6: [::1]:27017
      return bracketed ? bracketed[1] : h.replace(/:\d+$/, "");
    })
    .filter(Boolean);
}

/** True only for a plain mongodb:// URI whose every host is this computer. */
function isLocalUri(uri) {
  if (/^mongodb\+srv:/i.test(String(uri))) return false;
  const hosts = hostsOf(uri);
  return hosts.length > 0 && hosts.every((h) => /^(localhost|127(\.\d{1,3}){3}|::1)$/i.test(h));
}

/** "host1,host2/dbname", never with credentials or options. */
function describeTarget(uri) {
  const rest = String(uri).replace(/^mongodb(\+srv)?:\/\//i, "");
  const afterAuth = rest.includes("@") ? rest.slice(rest.lastIndexOf("@") + 1) : rest;
  const [authority, path = ""] = afterAuth.split("/");
  const db = path.split("?")[0];
  return `${authority.split("?")[0]}/${db || "(default database)"}`;
}

/** A new random password, 24 characters, different every call. */
function generatePassword() {
  return crypto.randomBytes(18).toString("base64url");
}

module.exports = { hostsOf, isLocalUri, describeTarget, generatePassword };
