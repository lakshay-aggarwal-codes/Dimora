// Production readiness check (P17-T04): `npm run preflight` runs this against
// the environment you are about to deploy with. It adds the stricter rules a
// deployment needs on top of src/config/env.js (which only has to let a
// development machine start). It never prints a secret value.
const { validateEnv, EnvValidationError } = require("./env");

const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i;

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

/**
 * @param {object} source        environment variables (strings)
 * @param {object} [context]
 * @param {string} [context.gitignoreText]  contents of .gitignore, if known
 * @param {boolean} [context.hasLockfile]
 * @param {string} [context.nodeVersion]    e.g. process.version
 * @param {Function} [context.validate]     replaces validateEnv (tests)
 * @returns {{ ok: boolean, results: {level: "ok"|"warn"|"fail", id: string, message: string}[] }}
 */
function checkProduction(source = process.env, context = {}) {
  const results = [];
  const add = (level, id, message) => results.push({ level, id, message });
  const env = { ...source, NODE_ENV: "production" };
  const validate = context.validate || validateEnv;

  // 1. Everything the app itself insists on in production.
  try {
    validate(env);
    add("ok", "env", "All required settings are present and valid for production.");
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    for (const problem of err.problems) add("fail", "env", problem);
  }

  // 2. The public address.
  const base = (env.APP_BASE_URL || "").trim();
  if (base) {
    if (!/^https:\/\//i.test(base)) add("fail", "https", "APP_BASE_URL must start with https:// in production (cookies are Secure, links are built from it).");
    else if (LOCAL_HOST.test(hostOf(base))) add("fail", "base-url", "APP_BASE_URL points at this machine.");
    else add("ok", "https", "APP_BASE_URL is an https address.");
  }

  // 3. The database.
  const mongo = (env.MONGODB_URI || env.ATLASDB_URL || "").trim();
  if (mongo) {
    if (LOCAL_HOST.test(hostOf(mongo.replace(/^mongodb(\+srv)?:/, "http:")))) add("fail", "database", "MONGODB_URI points at this machine; use the hosted database.");
    else if (!/^mongodb\+srv:/.test(mongo) && !/[?&]tls=true|[?&]ssl=true/i.test(mongo)) add("warn", "database", "MONGODB_URI is not mongodb+srv:// and has no tls=true: the connection may not be encrypted.");
    else add("ok", "database", "MONGODB_URI is a hosted database over TLS.");
  }

  // 4. The session secret also keys the approximate public location offset.
  const secret = (env.SESSION_SECRET || "").trim();
  if (secret) {
    if (new Set(secret).size < 12) add("fail", "secret", "SESSION_SECRET has too few different characters; generate a random one (see .env.example).");
    else add("ok", "secret", "SESSION_SECRET is long and varied.");
  }

  // 5. Nearby places (on by default) should identify us to the Overpass operators.
  if (!/^(false|0|no|off)$/i.test((env.NEARBY_ENABLED || "").trim())) {
    if (!(env.NEARBY_CONTACT || "").trim()) add("warn", "nearby", "NEARBY_CONTACT is empty: Overpass operators cannot reach you. Set an email or URL, or NEARBY_ENABLED=false.");
    else add("ok", "nearby", "NEARBY_CONTACT is set.");
  }

  // 6. The housekeeping job.
  if (/^(false|0|no|off)$/i.test((env.SWEEPER_ENABLED || "").trim())) add("warn", "sweeper", "SWEEPER_ENABLED=false: unanswered booking requests will not expire.");

  // 7. Project files.
  if (context.gitignoreText !== undefined) {
    if (!/^\.env\s*$/m.test(context.gitignoreText)) add("fail", "gitignore", ".env is not listed in .gitignore.");
    else add("ok", "gitignore", ".env is git-ignored.");
  }
  if (context.hasLockfile === false) add("fail", "lockfile", "package-lock.json is missing; install with npm ci from a committed lockfile.");
  if (context.nodeVersion) {
    const [major, minor] = context.nodeVersion.replace(/^v/, "").split(".").map(Number);
    if (major < 20 || (major === 20 && minor < 19)) add("fail", "node", `Node ${context.nodeVersion} is older than the 20.19 the app needs.`);
  }

  return { ok: !results.some((r) => r.level === "fail"), results };
}

module.exports = { checkProduction };
