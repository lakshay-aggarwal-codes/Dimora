// A small secret scanner (P17-T04): no dependency, no network, same idea as
// gitleaks but only for the kinds of secret this project can have. It never
// prints a secret: only the file, the line, the rule and the first 4 characters.
//
//   npm run scan:secrets                      scan the working tree
//   git log --all -p | node scripts/scan-secrets.js --stdin     scan all history
const fs = require("node:fs");
const path = require("node:path");

const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", ".mongoms-cache"]);
// .env is the one place real secrets belong (it is git-ignored); the lockfile is only hashes.
const SKIP_FILES = new Set([".env", "package-lock.json"]);
const SKIP_EXT = /\.(zip|png|jpe?g|gif|webp|ico|woff2?|pdf)$/i;
const MAX_BYTES = 5 * 1024 * 1024;

// High confidence: a match anywhere is a finding.
const STRONG = [
  ["database URI with a password", /mongodb(?:\+srv)?:\/\/[^\s:/@"'<>`]+:([^\s@"'<>`]+)@/g, 1],
  ["Mapbox secret token", /\bsk\.eyJ[A-Za-z0-9_\-.]{20,}/g, 0],
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, 0],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/g, 0],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 0],
  ["Cloudinary URL with secret", /cloudinary:\/\/\d+:([^\s@"'<>`]+)@/g, 1],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 0],
  ["live payment key", /\b[rs]k_live_[A-Za-z0-9]{16,}/g, 0],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g, 0],
];

// Lower confidence: a secret-named setting with a long literal value. Not applied
// to tests and docs, where fixtures and examples live.
const ASSIGNMENT =
  /\b(SESSION_SECRET|CLOUDINARY_API_SECRET|CLOUD_API_SECRET|API_SECRET|SECRET_KEY|MAPBOX_SERVER_TOKEN|MONGODB_URI|ATLASDB_URL)\b\s*[=:]\s*["']?([A-Za-z0-9_\-/+=.:@]{20,})/g;

const PLACEHOLDER =
  /^(?:<.*>|\$\{.*\}|%s|\.{3,}|\*+|x{3,}|your[-_ ]|change[-_ ]?me|replace[-_ ]?me|example|placeholder|password$|pass$|secret$|process\.env)/i;
const isPlaceholder = (value) => PLACEHOLDER.test(value) || /^(?:user|username|db|host)?:?$/i.test(value);

const isExemptPath = (file) => /^(?:tests|docs)[\\/]/.test(file) || /\.env\.example$/.test(file);

/**
 * @param {string} file name used in the report (relative path)
 * @param {string} text
 * @returns {{file:string,line:number,rule:string,preview:string}[]}
 */
function scanText(file, text) {
  const findings = [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const add = (rule, index, value) =>
    findings.push({ file, line: lineOf(index), rule, preview: `${value.slice(0, 4)}\u2026(${value.length} chars)` });

  for (const [rule, pattern, group] of STRONG) {
    for (const match of text.matchAll(pattern)) {
      const value = match[group] || match[0];
      if (group && isPlaceholder(value)) continue;
      add(rule, match.index, value);
    }
  }
  if (!isExemptPath(file)) {
    for (const match of text.matchAll(ASSIGNMENT)) {
      const value = match[2];
      if (isPlaceholder(value)) continue;
      add(`literal value for ${match[1]}`, match.index, value);
    }
  }
  return findings;
}

function decode(buffer) {
  // The Windows PowerShell redirect writes UTF-16 with a byte-order mark.
  if (buffer.length > 1 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString("utf16le");
  return buffer.toString("utf8");
}

function scanTree(root, { skipDirs = SKIP_DIRS } = {}) {
  const findings = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full);
      } else if (!SKIP_FILES.has(entry.name) && !SKIP_EXT.test(entry.name)) {
        if (fs.statSync(full).size > MAX_BYTES) continue;
        const relative = path.relative(root, full).split(path.sep).join("/");
        findings.push(...scanText(relative, decode(fs.readFileSync(full))));
      }
    }
  };
  walk(root);
  return findings;
}

module.exports = { scanText, scanTree, isPlaceholder };
