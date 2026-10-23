const assert = require("node:assert/strict");
const { validateEnv, EnvValidationError } = require("../../src/config/env");

const VALID = {
  NODE_ENV: "development",
  MONGODB_URI: "mongodb://127.0.0.1:27017/dimora",
  SESSION_SECRET: "dev-secret-not-for-production",
  CLOUDINARY_CLOUD_NAME: "cloud",
  CLOUDINARY_API_KEY: "key",
  CLOUDINARY_API_SECRET: "api-secret-value",
  MAPBOX_SERVER_TOKEN: "pk.server",
  MAPBOX_PUBLIC_TOKEN: "pk.public",
};
const PROD = {
  ...VALID,
  NODE_ENV: "production",
  SESSION_SECRET: "a".repeat(16) + "B1" + "c".repeat(16),
  APP_BASE_URL: "https://dimora.example.com",
};

function problemsOf(env) {
  try {
    validateEnv(env);
  } catch (err) {
    assert.ok(err instanceof EnvValidationError);
    return err.problems;
  }
  return [];
}

test("valid development env passes and applies defaults", () => {
  const cfg = validateEnv(VALID);
  assert.equal(cfg.env, "development");
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.appBaseUrl, "http://localhost:8080");
  assert.deepEqual(cfg.dnsServers, []);
  assert.equal(cfg.cloudinary.cloudName, "cloud");
  assert.equal(cfg.mapbox.publicToken, "pk.public");
});

test("valid production env passes", () => {
  const cfg = validateEnv(PROD);
  assert.equal(cfg.isProduction, true);
  assert.equal(cfg.appBaseUrl, "https://dimora.example.com");
});

for (const key of [
  "MONGODB_URI",
  "SESSION_SECRET",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "MAPBOX_SERVER_TOKEN",
  "MAPBOX_PUBLIC_TOKEN",
]) {
  test(`missing ${key} yields its own message`, () => {
    const env = { ...VALID };
    delete env[key];
    const problems = problemsOf(env);
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0], new RegExp(`^${key} is missing`));
  });

  test(`empty ${key} counts as missing`, () => {
    const problems = problemsOf({ ...VALID, [key]: "   " });
    assert.match(problems.join("\n"), new RegExp(`${key} is missing`));
  });
}

test("several missing keys are all reported together", () => {
  const problems = problemsOf({ NODE_ENV: "development" });
  assert.equal(problems.length, 7);
});

test("SESSION_SECRET shorter than 32 chars is rejected in production only", () => {
  const short = { ...PROD, SESSION_SECRET: "short-but-unique-value" };
  assert.match(
    problemsOf(short).join("\n"),
    /SESSION_SECRET must be at least 32/,
  );
  assert.deepEqual(
    problemsOf({ ...VALID, SESSION_SECRET: "short-but-unique-value" }),
    [],
  );
});

test("missing SESSION_SECRET in production fails with a clear message", () => {
  const env = { ...PROD };
  delete env.SESSION_SECRET;
  assert.match(problemsOf(env)[0], /SESSION_SECRET is missing/);
});

test("placeholder secret rejected in production", () => {
  const env = { ...PROD, SESSION_SECRET: "changeme".padEnd(40, "x") };
  assert.match(problemsOf(env).join("\n"), /placeholder/);
});

test("the old committed secret is rejected in every environment", () => {
  assert.match(
    problemsOf({ ...VALID, SESSION_SECRET: "mysupersecretcode" }).join("\n"),
    /old secret/,
  );
});

test("production requires APP_BASE_URL; development does not", () => {
  const env = { ...PROD };
  delete env.APP_BASE_URL;
  assert.match(problemsOf(env).join("\n"), /APP_BASE_URL/);
});

test("invalid NODE_ENV, PORT, URI and base URL are reported", () => {
  const problems = problemsOf({
    ...VALID,
    NODE_ENV: "staging",
    PORT: "99999",
    MONGODB_URI: "http://x",
  });
  const text = problems.join("\n");
  assert.match(text, /NODE_ENV must be one of/);
  assert.match(text, /PORT/);
  assert.match(text, /MONGODB_URI must start with mongodb/);
});

test("secret Mapbox token as public token: error in production, warning otherwise", () => {
  assert.match(
    problemsOf({ ...PROD, MAPBOX_PUBLIC_TOKEN: "sk.secret" }).join("\n"),
    /secret \(sk\.\)/,
  );
  const cfg = validateEnv({ ...VALID, MAPBOX_PUBLIC_TOKEN: "sk.secret" });
  assert.ok(cfg.warnings.some((w) => /sk\./.test(w)));
});

test("server and public token must differ: error in production, warning otherwise", () => {
  const same = {
    MAPBOX_SERVER_TOKEN: "pk.same",
    MAPBOX_PUBLIC_TOKEN: "pk.same",
  };
  assert.match(problemsOf({ ...PROD, ...same }).join("\n"), /same token/);
  const cfg = validateEnv({ ...VALID, ...same });
  assert.ok(cfg.warnings.some((w) => /same token/.test(w)));
  assert.deepEqual(problemsOf(PROD), []);
});

test("MAPBOX_GEOCODING_PERMANENT defaults to false and accepts true/false", () => {
  assert.equal(validateEnv(VALID).mapbox.permanentGeocoding, false);
  assert.equal(
    validateEnv({ ...VALID, MAPBOX_GEOCODING_PERMANENT: "true" }).mapbox
      .permanentGeocoding,
    true,
  );
  assert.match(
    problemsOf({ ...VALID, MAPBOX_GEOCODING_PERMANENT: "maybe" }).join("\n"),
    /MAPBOX_GEOCODING_PERMANENT/,
  );
});

test("legacy variable names still work and produce warnings", () => {
  const legacy = {
    ATLASDB_URL: VALID.MONGODB_URI,
    SESSION_SECRET: VALID.SESSION_SECRET,
    CLOUD_NAME: "cloud",
    CLOUD_API_KEY: "key",
    CLOUD_API_SECRET: "api-secret-value",
    MAP_TOKEN: "pk.legacy",
  };
  const cfg = validateEnv(legacy);
  assert.equal(cfg.mongodbUri, VALID.MONGODB_URI);
  assert.equal(cfg.mapbox.serverToken, "pk.legacy");
  assert.equal(cfg.mapbox.publicToken, "pk.legacy");
  // 6 deprecated names + 1 for the shared MAP_TOKEN (same server and public token)
  assert.equal(cfg.warnings.length, 7);
});

test("new names win over legacy names", () => {
  const cfg = validateEnv({
    ...VALID,
    ATLASDB_URL: "mongodb://old/db",
    MAP_TOKEN: "pk.old",
  });
  assert.equal(cfg.mongodbUri, VALID.MONGODB_URI);
  assert.equal(cfg.mapbox.publicToken, "pk.public");
});

test("DNS_SERVERS is parsed when set and validated", () => {
  assert.deepEqual(
    validateEnv({ ...VALID, DNS_SERVERS: "8.8.8.8, 1.1.1.1" }).dnsServers,
    ["8.8.8.8", "1.1.1.1"],
  );
  assert.match(
    problemsOf({ ...VALID, DNS_SERVERS: "not-an-ip" }).join("\n"),
    /DNS_SERVERS/,
  );
});

test("error output lists problems but never echoes secret values", () => {
  let text = "";
  try {
    validateEnv({
      ...VALID,
      SESSION_SECRET: "hunter2-secret-value",
      MONGODB_URI: "http://leaky-user:pw@host",
    });
  } catch (err) {
    text = err.format() + err.message;
  }
  assert.ok(text.includes("MONGODB_URI"));
  assert.ok(!text.includes("leaky-user"));
  assert.ok(!text.includes("hunter2-secret-value"));
});

test("the sweeper is on by default, every 60 seconds", () => {
  const cfg = validateEnv(VALID);
  assert.equal(cfg.sweeper.enabled, true);
  assert.equal(cfg.sweeper.intervalMs, 60000);
});

test("the sweeper can be paused and its interval set", () => {
  const cfg = validateEnv({ ...VALID, SWEEPER_ENABLED: "false", SWEEPER_INTERVAL_SECONDS: "30" });
  assert.equal(cfg.sweeper.enabled, false);
  assert.equal(cfg.sweeper.intervalMs, 30000);
});

test("a nonsense sweeper interval is refused", () => {
  for (const value of ["0", "2", "99999", "soon", "1.5"]) {
    assert.match(
      problemsOf({ ...VALID, SWEEPER_INTERVAL_SECONDS: value }).join("\n"),
      /SWEEPER_INTERVAL_SECONDS/,
      value,
    );
  }
  assert.match(problemsOf({ ...VALID, SWEEPER_ENABLED: "maybe" }).join("\n"), /SWEEPER_ENABLED/);
});

test("the review window is 30 days by default and can be set", () => {
  assert.equal(validateEnv(VALID).reviews.windowDays, 30);
  assert.equal(validateEnv({ ...VALID, REVIEW_WINDOW_DAYS: "14" }).reviews.windowDays, 14);
});

test("a review window outside 1 to 365 whole days is refused", () => {
  for (const bad of ["0", "366", "1.5", "soon"]) {
    assert.throws(() => validateEnv({ ...VALID, REVIEW_WINDOW_DAYS: bad }), /REVIEW_WINDOW_DAYS/);
  }
});
