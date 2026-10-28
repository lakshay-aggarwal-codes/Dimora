// P19-T03: render.yaml must stay in step with the app's settings and carry no secret.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const yaml = fs.readFileSync(path.join(ROOT, "render.yaml"), "utf8");
const envSrc = fs.readFileSync(path.join(ROOT, "src", "config", "env.js"), "utf8");
const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

// The keys of the blueprint's envVars, each with its block of lines.
function blueprintVars() {
  const vars = {};
  const lines = yaml.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const key = line.match(/^\s*- key:\s*([A-Z0-9_]+)/);
    if (key) {
      current = key[1];
      vars[current] = [];
    } else if (current && /^\s{8,}\S/.test(line) && !line.trim().startsWith("#")) {
      vars[current].push(line.trim());
    }
  }
  return vars;
}

const vars = blueprintVars();
const REQUIRED_BY_APP = [
  "MONGODB_URI",
  "SESSION_SECRET",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "MAPBOX_SERVER_TOKEN",
  "MAPBOX_PUBLIC_TOKEN",
  "APP_BASE_URL",
];

test("it is a free Node web service that checks /healthz", () => {
  assert.match(yaml, /^\s*- type: web$/m);
  assert.match(yaml, /^\s*runtime: node$/m);
  assert.match(yaml, /^\s*plan: free$/m);
  assert.match(yaml, /^\s*healthCheckPath: \/healthz$/m);
  assert.match(yaml, /^\s*startCommand: node server\.js$/m);
});

test("migrations run in the build command (no pre-deploy command on the free plan)", () => {
  assert.match(yaml, /^\s*buildCommand: npm ci && npm run migrate$/m);
  assert.doesNotMatch(yaml, /^\s*preDeployCommand:/m);
});

test("every setting the app requires in production is in the blueprint", () => {
  for (const key of REQUIRED_BY_APP) assert.ok(vars[key], `${key} missing from render.yaml`);
});

test("every secret is asked for in the dashboard (sync: false) or generated, never written here", () => {
  const SECRETS = [
    "MONGODB_URI",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "MAPBOX_SERVER_TOKEN",
  ];
  for (const key of SECRETS) assert.deepEqual(vars[key], ["sync: false"], key);
  assert.deepEqual(vars.SESSION_SECRET, ["generateValue: true"]);
  assert.doesNotMatch(yaml, /mongodb(\+srv)?:\/\/[^\s]*@/i);
  assert.doesNotMatch(yaml, /\b(sk|pk)\.[A-Za-z0-9]{10,}/);
});

test("production mode and a pinned Node version are set", () => {
  assert.deepEqual(vars.NODE_ENV, ["value: production"]);
  assert.match(vars.NODE_VERSION[0], /^value: \d+\.\d+\.\d+$/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const major = Number(vars.NODE_VERSION[0].match(/\d+/)[0]);
  assert.ok(major >= 20, `package.json needs ${pkg.engines.node}`);
});

test("every optional setting it sets exists in the app's settings and .env.example", () => {
  for (const key of Object.keys(vars)) {
    if (["NODE_VERSION"].includes(key)) continue; // read by Render, not by Dimora
    const known = envSrc.includes(`"${key}"`) || envSrc.includes(`${key}:`) || /NEARBY_/.test(key);
    assert.ok(known, `${key} is not a setting Dimora reads`);
    assert.ok(envExample.includes(`${key}=`), `${key} is missing from .env.example`);
  }
});

test("the package scripts the deployment docs rely on exist", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const name of ["start", "migrate", "migrate:dry", "make-admin", "preflight", "smoke:deploy"]) {
    assert.ok(pkg.scripts[name], `npm run ${name} is missing`);
  }
});
