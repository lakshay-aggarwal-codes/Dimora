// Production readiness check (P17-T04):
//
//   npm run preflight
//
// Reads .env (and the real environment) as if NODE_ENV were production and
// reports what would be wrong for a deployment. Exit code 1 when anything fails.
// Secret values are never printed. See docs/SECURITY.md for the full checklist.
const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config({ quiet: true });
const { checkProduction } = require("../src/config/preflight");

const root = path.join(__dirname, "..");
const read = (name) => {
  try {
    return fs.readFileSync(path.join(root, name), "utf8");
  } catch {
    return undefined;
  }
};

const { ok, results } = checkProduction(process.env, {
  gitignoreText: read(".gitignore"),
  hasLockfile: fs.existsSync(path.join(root, "package-lock.json")),
  nodeVersion: process.version,
});

const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" };
for (const r of results) console.log(`${mark[r.level]}  ${r.message}`);
const warnings = results.filter((r) => r.level === "warn").length;
console.log(ok ? `Ready for production${warnings ? ` (${warnings} warning(s))` : ""}.` : "Not ready for production.");
process.exitCode = ok ? 0 : 1;
