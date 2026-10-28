const Joi = require("joi");

// Names used before this module existed. Still accepted (with a warning) so an
// existing .env keeps working; remove them from .env when convenient.
const LEGACY_NAMES = {
  MONGODB_URI: ["ATLASDB_URL"],
  CLOUDINARY_CLOUD_NAME: ["CLOUD_NAME"],
  CLOUDINARY_API_KEY: ["CLOUD_API_KEY"],
  CLOUDINARY_API_SECRET: ["CLOUD_API_SECRET"],
  MAPBOX_SERVER_TOKEN: ["MAP_TOKEN"],
  MAPBOX_PUBLIC_TOKEN: ["MAP_TOKEN"],
};

const KEYS = [
  "NODE_ENV",
  "PORT",
  "MONGODB_URI",
  "SESSION_SECRET",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "MAPBOX_SERVER_TOKEN",
  "MAPBOX_PUBLIC_TOKEN",
  "MAPBOX_GEOCODING_PERMANENT",
  "APP_BASE_URL",
  "DNS_SERVERS",
  "SWEEPER_ENABLED",
  "SWEEPER_INTERVAL_SECONDS",
  "REVIEW_WINDOW_DAYS",
  "TRUST_PROXY_HOPS",
  "EMAIL_TRANSPORT",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "EMAIL_VERIFICATION_REQUIRED",
];

// Secrets that were committed to the repository or are obvious placeholders.
const KNOWN_LEAKED_SECRETS = ["mysupersecretcode"];
const PLACEHOLDER_PATTERN =
  /^(change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|placeholder|secret$|password$|test$|todo|xxx)/i;

class EnvValidationError extends Error {
  constructor(problems, warnings = []) {
    super(`Invalid environment configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.problems = problems;
    this.warnings = warnings;
  }

  format() {
    return [
      "Dimora cannot start: invalid environment configuration.",
      ...this.problems.map((p) => `  - ${p}`),
      "Copy .env.example to .env and fill in the missing values.",
    ].join("\n");
  }
}

const schema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),
  PORT: Joi.number().integer().min(1).max(65535).default(8080),
  MONGODB_URI: Joi.string()
    .pattern(/^mongodb(\+srv)?:\/\//)
    .required()
    .messages({
      "string.pattern.base": "MONGODB_URI must start with mongodb:// or mongodb+srv://",
    }),
  SESSION_SECRET: Joi.string()
    .required()
    .when("NODE_ENV", {
      is: "production",
      then: Joi.string().min(32).messages({
        "string.min": "SESSION_SECRET must be at least 32 characters in production",
      }),
    }),
  CLOUDINARY_CLOUD_NAME: Joi.string().required(),
  CLOUDINARY_API_KEY: Joi.string().required(),
  CLOUDINARY_API_SECRET: Joi.string().required(),
  MAPBOX_SERVER_TOKEN: Joi.string().required(),
  MAPBOX_PUBLIC_TOKEN: Joi.string().required(),
  // true = geocode with Mapbox's "permanent" mode, the licence for results that
  // are stored in the database (ADR-007). Off by default: see the ADR first.
  MAPBOX_GEOCODING_PERMANENT: Joi.boolean().default(false),
  APP_BASE_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .when("NODE_ENV", { is: "production", then: Joi.required() })
    .messages({ "string.uriCustomScheme": "APP_BASE_URL must start with http:// or https://" }),
  DNS_SERVERS: Joi.string().optional(),
  // Housekeeping job (P07-T07): expires unanswered booking requests, completes
  // finished stays, removes orphaned ledger rows and old drafts.
  SWEEPER_ENABLED: Joi.boolean().default(true),
  SWEEPER_INTERVAL_SECONDS: Joi.number().integer().min(5).max(3600).default(60),
  // How many days after check-out a guest may still review the stay (P12-T01).
  REVIEW_WINDOW_DAYS: Joi.number().integer().min(1).max(365).default(30),
  // How many reverse proxies sit in front of the app in production (P19-T03).
  // Express uses it to find the real client address (rate limits, secure
  // cookies). Default 1; see docs/DEPLOYMENT.md before changing it.
  TRUST_PROXY_HOPS: Joi.number().integer().min(1).max(5).default(1),
  // Email (P02-T05). "console" writes the message to the server log (development:
  // the link you would click is in the terminal); "resend" sends it through
  // Resend's HTTPS API (docs/EMAIL.md; hosts such as Render's free plan block SMTP).
  EMAIL_TRANSPORT: Joi.string().valid("console", "resend").default("console"),
  EMAIL_FROM: Joi.string().max(200).default("Dimora <no-reply@localhost>"),
  RESEND_API_KEY: Joi.string().max(200),
  // false = signing up still works and nothing asks for a confirmed address.
  // For a deployment that cannot send email. Default true.
  EMAIL_VERIFICATION_REQUIRED: Joi.boolean().default(true),
});

function isPlaceholder(value) {
  return KNOWN_LEAKED_SECRETS.includes(value) || PLACEHOLDER_PATTERN.test(value);
}

function describe(detail) {
  const key = detail.path[0];
  if (detail.type === "any.required" || detail.type === "string.empty") {
    const legacy = LEGACY_NAMES[key];
    return `${key} is missing${legacy ? ` (old name ${legacy.join("/")} is also accepted)` : ""}`;
  }
  if (detail.type === "any.only" && key === "NODE_ENV") {
    return "NODE_ENV must be one of development, test, production";
  }
  return detail.message.replace(/"/g, "");
}

/**
 * Pure validation: reads only from `source` (default process.env), never exits,
 * never logs. Returns a frozen config object or throws EnvValidationError.
 */
function validateEnv(source = process.env) {
  const warnings = [];
  const raw = {};
  for (const key of KEYS) {
    const value = typeof source[key] === "string" ? source[key].trim() : "";
    if (value) raw[key] = value;
  }
  for (const [key, olds] of Object.entries(LEGACY_NAMES)) {
    if (raw[key]) continue;
    for (const old of olds) {
      const value = typeof source[old] === "string" ? source[old].trim() : "";
      if (value) {
        raw[key] = value;
        warnings.push(`${old} is deprecated; rename it to ${key} in .env`);
        break;
      }
    }
  }

  const { value, error } = schema.validate(raw, { abortEarly: false, convert: true });
  const problems = error ? error.details.map(describe) : [];
  const env = (value && value.NODE_ENV) || "development";
  const isProduction = env === "production";

  let dnsServers = [];
  if (raw.DNS_SERVERS) {
    dnsServers = raw.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean);
    if (dnsServers.some((ip) => Joi.string().ip().validate(ip).error)) {
      problems.push("DNS_SERVERS must be a comma-separated list of IP addresses");
    }
  }

  if (raw.SESSION_SECRET && KNOWN_LEAKED_SECRETS.includes(raw.SESSION_SECRET)) {
    problems.push("SESSION_SECRET is the old secret that was committed to the repository; generate a new one");
  } else if (isProduction && raw.SESSION_SECRET && isPlaceholder(raw.SESSION_SECRET)) {
    problems.push("SESSION_SECRET looks like a placeholder; use a long random value in production");
  }
  if (isProduction && raw.CLOUDINARY_API_SECRET && isPlaceholder(raw.CLOUDINARY_API_SECRET)) {
    problems.push("CLOUDINARY_API_SECRET looks like a placeholder");
  }
  if (raw.MAPBOX_PUBLIC_TOKEN && raw.MAPBOX_PUBLIC_TOKEN.startsWith("sk.")) {
    const msg = "MAPBOX_PUBLIC_TOKEN is a secret (sk.) token; it is sent to browsers, so use a public (pk.) token";
    if (isProduction) problems.push(msg);
    else warnings.push(msg);
  }
  // One token for both jobs defeats the split (ADR-007): whatever the browser
  // can read could then call the geocoding API.
  if (
    raw.MAPBOX_SERVER_TOKEN &&
    raw.MAPBOX_SERVER_TOKEN === raw.MAPBOX_PUBLIC_TOKEN
  ) {
    const msg =
      "MAPBOX_SERVER_TOKEN and MAPBOX_PUBLIC_TOKEN are the same token; the public token is sent to browsers, so create a separate server token";
    if (isProduction) problems.push(msg);
    else warnings.push(msg);
  }

  if (value && value.EMAIL_TRANSPORT === "resend") {
    if (!raw.RESEND_API_KEY) problems.push("RESEND_API_KEY is missing (EMAIL_TRANSPORT=resend)");
    if (!raw.EMAIL_FROM) problems.push("EMAIL_FROM is missing (EMAIL_TRANSPORT=resend); use an address on a domain you verified with Resend");
  }
  if (isProduction && value && value.EMAIL_TRANSPORT === "console") {
    warnings.push(
      value.EMAIL_VERIFICATION_REQUIRED === false
        ? "EMAIL_TRANSPORT=console in production: no email is delivered (password reset by email does not work)"
        : "EMAIL_TRANSPORT=console in production and EMAIL_VERIFICATION_REQUIRED is on: nobody can confirm an address, so nobody can publish a listing or book; set up Resend (docs/EMAIL.md) or set EMAIL_VERIFICATION_REQUIRED=false",
    );
  }

  if (problems.length) throw new EnvValidationError(problems, warnings);

  const port = value.PORT;
  return Object.freeze({
    env,
    isProduction,
    isTest: env === "test",
    port,
    mongodbUri: value.MONGODB_URI,
    sessionSecret: value.SESSION_SECRET,
    cloudinary: Object.freeze({
      cloudName: value.CLOUDINARY_CLOUD_NAME,
      apiKey: value.CLOUDINARY_API_KEY,
      apiSecret: value.CLOUDINARY_API_SECRET,
    }),
    mapbox: Object.freeze({
      serverToken: value.MAPBOX_SERVER_TOKEN,
      publicToken: value.MAPBOX_PUBLIC_TOKEN,
      permanentGeocoding: value.MAPBOX_GEOCODING_PERMANENT === true,
    }),
    appBaseUrl: value.APP_BASE_URL || `http://localhost:${port}`,
    dnsServers,
    sweeper: Object.freeze({
      enabled: value.SWEEPER_ENABLED !== false,
      intervalMs: value.SWEEPER_INTERVAL_SECONDS * 1000,
    }),
    reviews: Object.freeze({ windowDays: value.REVIEW_WINDOW_DAYS }),
    trustProxyHops: value.TRUST_PROXY_HOPS,
    email: Object.freeze({
      transport: value.EMAIL_TRANSPORT,
      from: value.EMAIL_FROM,
      resendApiKey: value.RESEND_API_KEY || null,
      verificationRequired: value.EMAIL_VERIFICATION_REQUIRED !== false,
    }),
    warnings: Object.freeze(warnings),
  });
}

let cached = null;

/** Validates process.env once and memoises the result. Throws EnvValidationError. */
function loadEnv() {
  if (!cached) cached = validateEnv(process.env);
  return cached;
}

function resetConfigCache() {
  cached = null;
}

module.exports = { validateEnv, loadEnv, resetConfigCache, EnvValidationError };
