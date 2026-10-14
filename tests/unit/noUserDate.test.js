// P07-T01 acceptance: no code path turns a user string into a Date with
// `new Date(userString)` or Date.parse. Application code gets dates only from
// src/utils/dates.js (strict YYYY-MM-DD). Zero-argument `new Date()` (now) is
// fine; anything else outside the date utility fails this test.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const SCAN = ["src", "scripts", "views", "public/js", "server.js"];
const ALLOWED = new Set(["src/utils/dates.js"]);
const FORBIDDEN = [
  { pattern: /new\s+Date\(\s*[^\s)]/, label: "new Date(<argument>)" },
  { pattern: /\bDate\.parse\s*\(/, label: "Date.parse(...)" },
];

function listFiles(target) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [target];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(target, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listFiles(rel);
    return /\.(js|ejs)$/.test(entry.name) ? [rel] : [];
  });
}

describe("no new Date(userString)", () => {
  test("application code only builds dates through src/utils/dates.js", () => {
    const offenders = [];
    for (const file of SCAN.flatMap(listFiles)) {
      if (ALLOWED.has(file)) continue;
      const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const { pattern, label } of FORBIDDEN) {
          if (pattern.test(line)) {
            offenders.push(`${file}:${index + 1} ${label}: ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the scanner itself would catch a violation", () => {
    for (const bad of [
      "const d = new Date(req.query.in);",
      "new Date( value )",
      "Date.parse(input)",
    ]) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(bad))).toBe(true);
    }
    for (const ok of ["const now = new Date();", "Date.now()", "new Date( )"]) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(ok))).toBe(false);
    }
  });
});
