// P19-T02: the demo data and the guards of scripts/seed-demo.js. No database:
// every listing is validated against the real model in memory, and the booking
// plan is checked against the rules the real services enforce.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const mongoose = require("mongoose");
const Listing = require("../../src/models/listing");
const { evaluateReadiness } = require("../../src/services/readiness");
const { STATUSES } = require("../../src/services/stateMachine");
const { AMENITIES } = require("../../src/config/constants");
const { data: sample } = require("../../scripts/seed-data");
const {
  DEMO_ACCOUNTS,
  EXTRAS,
  SCENARIOS,
  PHOTOS_PER_LISTING,
  CSP_IMAGE_HOST,
  buildDemoListings,
  planReservations,
} = require("../../scripts/demo-data");
const {
  parseArgs,
  isLocalUri,
  describeTarget,
  generatePassword,
} = require("../../scripts/seed-demo");

const owner = new mongoose.Types.ObjectId();
const listings = buildDemoListings(owner);
const byTitle = new Map(listings.map((doc) => [doc.title, doc]));
const TODAY = new Date(Date.UTC(2026, 9, 28));
const NOW = new Date("2026-10-28T06:00:00Z");
const plan = planReservations(TODAY, NOW);

describe("demo listings", () => {
  test("there are about 30, one for each sample place, with a table row each", () => {
    expect(listings).toHaveLength(sample.length);
    expect(listings.length).toBeGreaterThanOrEqual(29);
    expect(new Set(listings.map((l) => l.title)).size).toBe(listings.length);
    expect(Object.keys(EXTRAS).sort()).toEqual(sample.map((s) => s.title).sort());
  });

  test("every one passes the real Listing model", () => {
    for (const doc of listings) {
      const error = new Listing(doc).validateSync();
      expect(error ? `${doc.title}: ${error.message}` : undefined).toBeUndefined();
    }
  });

  test("every one is published, owned by the host and has a valid point", () => {
    for (const doc of listings) {
      expect(doc.status).toBe("published");
      expect(String(doc.owner)).toBe(String(owner));
      expect(doc.geometry.type).toBe("Point");
      const [lng, lat] = doc.geometry.coordinates;
      expect(Math.abs(lng)).toBeLessThanOrEqual(180);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
    }
  });

  test("every one passes the Host Readiness Checklist, so My listings shows 100%", () => {
    for (const doc of listings) {
      const result = evaluateReadiness(doc);
      expect({ title: doc.title, failed: result.checks.filter((c) => !c.passed).map((c) => c.key) }).toEqual({
        title: doc.title,
        failed: [],
      });
    }
  });

  test("every one has several different photos, the cover first, with alt text", () => {
    for (const doc of listings) {
      expect(doc.images).toHaveLength(PHOTOS_PER_LISTING);
      expect(new Set(doc.images.map((i) => i.url)).size).toBe(PHOTOS_PER_LISTING);
      expect(doc.images[0].url).toBe(doc.image.url);
      expect(doc.images.map((i) => i.order)).toEqual([0, 1, 2, 3, 4]);
      for (const image of doc.images) expect(image.alt).toContain(doc.title);
      // the photos added to a cover come only from a host the CSP allows
      for (const image of doc.images.slice(1)) expect(image.url.startsWith(CSP_IMAGE_HOST)).toBe(true);
    }
  });

  test("prices are whole paise, fees are set and the weekend price is only a premium", () => {
    for (const doc of listings) {
      expect(Number.isInteger(doc.pricing.nightlyMinor)).toBe(true);
      expect(doc.pricing.nightlyMinor).toBeGreaterThanOrEqual(10000);
      expect(doc.pricing.cleaningFeeMinor).toBeGreaterThan(0);
      if (doc.pricing.weekendNightlyMinor !== undefined) {
        expect(doc.pricing.weekendNightlyMinor).toBeGreaterThan(doc.pricing.nightlyMinor);
      }
    }
    expect(listings.some((l) => l.pricing.weekendNightlyMinor)).toBe(true);
  });

  test("amenities are known codes, with no repeats; pool listings keep their pool", () => {
    const known = new Set(AMENITIES.map((a) => a.value));
    for (const doc of listings) {
      expect(new Set(doc.amenities).size).toBe(doc.amenities.length);
      for (const code of doc.amenities) expect(known.has(code)).toBe(true);
    }
    expect(byTitle.get("Luxury Villa in the Maldives").amenities).toContain("pool");
  });

  test("the mix has instant-book and request-to-book places and all three policies", () => {
    expect(new Set(listings.map((l) => l.instantBook))).toEqual(new Set([true, false]));
    expect(new Set(listings.map((l) => l.cancellationPolicy))).toEqual(
      new Set(["flexible", "moderate", "strict"]),
    );
  });

  test("the sample data is not modified and the search keys are set", () => {
    expect(sample.every((s) => !("amenities" in s) && !("images" in s))).toBe(true);
    for (const doc of listings) {
      expect(doc.cityKey).toBeTruthy();
      expect(doc.countryKey).toBeTruthy();
    }
  });
});

describe("demo accounts", () => {
  const accounts = Object.values(DEMO_ACCOUNTS);

  test("host, two guests and an admin, each unique and on a .invalid address", () => {
    expect(Object.keys(DEMO_ACCOUNTS).sort()).toEqual(["admin", "guest", "guest2", "host"]);
    expect(new Set(accounts.map((a) => a.username)).size).toBe(4);
    expect(new Set(accounts.map((a) => a.email)).size).toBe(4);
    for (const account of accounts) expect(account.email).toMatch(/@dimora\.invalid$/);
  });

  test("no password is written in the data", () => {
    expect(JSON.stringify(DEMO_ACCOUNTS)).not.toMatch(/password/i);
    for (const account of accounts) expect(Object.keys(account).sort()).toEqual(["bio", "displayName", "email", "username"]);
  });

  test("generated passwords are long, different every time and follow the signup rules", () => {
    const { signupSchema } = require("../../src/validation");
    const seen = new Set();
    for (let i = 0; i < 20; i += 1) {
      const password = generatePassword();
      expect(password.length).toBeGreaterThanOrEqual(20);
      seen.add(password);
    }
    expect(seen.size).toBe(20);
    const { error } = signupSchema.validate(
      { username: "dimora_demo_guest", email: "demo-guest@dimora.invalid", password: generatePassword() },
      { abortEarly: false },
    );
    expect(error).toBeUndefined();
  });
});

describe("demo reservations plan", () => {
  test("every reservation state is covered", () => {
    expect(new Set(SCENARIOS.map((s) => s.final))).toEqual(new Set(STATUSES));
  });

  test("keys are unique, valid idempotency keys, and each booking is for a different place", () => {
    expect(new Set(plan.map((p) => p.idempotencyKey)).size).toBe(plan.length);
    for (const p of plan) expect(p.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(new Set(plan.map((p) => p.listing)).size).toBe(plan.length);
  });

  test("bookers are the two guests; nobody books the host's own places for themselves", () => {
    for (const p of plan) expect(["guest", "guest2"]).toContain(p.guest);
  });

  test("each stay respects the place's minimum nights and capacity", () => {
    for (const p of plan) {
      const doc = byTitle.get(p.listing);
      expect({ key: p.key, found: Boolean(doc) }).toEqual({ key: p.key, found: true });
      expect(p.nights).toBeGreaterThanOrEqual(doc.minNights);
      expect(p.nights).toBeLessThanOrEqual(doc.maxNights);
      expect(p.guests).toBeLessThanOrEqual(doc.capacity.guests);
    }
  });

  test("the place's booking mode fits the path: requests need request-to-book, instant paths need instant book", () => {
    const requestPath = (p) => ["pending", "declined", "expired"].includes(p.final) || p.key === "g-confirmed-accepted";
    for (const p of plan) {
      const instant = byTitle.get(p.listing).instantBook;
      expect({ key: p.key, instant }).toEqual({ key: p.key, instant: !requestPath(p) });
    }
  });

  test("dates are real, check-out follows check-in by `nights`, offsets are from today", () => {
    const g = plan.find((p) => p.key === "g-pending");
    expect(g.checkIn).toBe("2026-11-21");
    expect(g.checkOut).toBe("2026-11-24");
    for (const p of plan) {
      const nights = (Date.parse(p.checkOut) - Date.parse(p.checkIn)) / 86400000;
      expect(nights).toBe(p.nights);
      expect(Date.parse(p.checkIn)).toBe(TODAY.getTime() + p.inDays * 86400000);
    }
  });

  test("completed stays are over, the rest have not started", () => {
    for (const p of plan) {
      if (p.final === "completed") expect(Date.parse(p.checkOut)).toBeLessThanOrEqual(TODAY.getTime());
      else expect(Date.parse(p.checkIn)).toBeGreaterThan(TODAY.getTime());
    }
  });

  test("each booking was made before check-in, and the host answers after the booking and before the hold ends", () => {
    for (const p of plan) {
      expect(p.bookedAt.getTime()).toBeLessThan(NOW.getTime());
      expect(p.bookedAt.getTime()).toBeLessThan(Date.parse(p.checkIn));
      if (p.respondedAt) {
        expect(p.respondedAt.getTime()).toBeGreaterThan(p.bookedAt.getTime());
        expect(p.respondedAt.getTime() - p.bookedAt.getTime()).toBeLessThan(24 * 3600 * 1000);
      }
    }
  });

  test("a request that is still waiting is still inside its 24 hour hold", () => {
    for (const p of plan.filter((x) => x.final === "pending")) {
      expect(NOW.getTime() - p.bookedAt.getTime()).toBeLessThan(24 * 3600 * 1000);
    }
  });

  test("the expired request was booked more than 24 hours ago", () => {
    const expired = plan.find((p) => p.final === "expired");
    expect(NOW.getTime() - expired.bookedAt.getTime()).toBeGreaterThan(24 * 3600 * 1000);
  });

  test("the guest's cancellation falls inside the partial-refund window of a moderate policy", () => {
    const p = plan.find((x) => x.final === "cancelled_by_guest");
    expect(byTitle.get(p.listing).cancellationPolicy).toBe("moderate");
    expect(p.inDays).toBeLessThan(5);
    expect(p.inDays).toBeGreaterThan(0);
  });

  test("the host's cancellation and the decline carry a reason; guest cancel too", () => {
    for (const final of ["cancelled_by_host", "declined", "cancelled_by_guest"]) {
      expect(plan.find((p) => p.final === final).reason).toEqual(expect.any(String));
    }
  });

  test("reviews sit only on completed stays, with a star rating and a comment", () => {
    const reviewed = plan.filter((p) => p.review);
    expect(reviewed.length).toBeGreaterThanOrEqual(3);
    for (const p of reviewed) {
      expect(p.final).toBe("completed");
      expect(Number.isInteger(p.review.rating) && p.review.rating >= 1 && p.review.rating <= 5).toBe(true);
      expect(p.review.comment.length).toBeGreaterThan(20);
      expect(p.review.comment.length).toBeLessThanOrEqual(2000);
    }
  });

  test("one finished stay can still be reviewed in the app and one is past the 30-day window", () => {
    const open = plan.filter((p) => p.final === "completed" && !p.review);
    const daysSince = (p) => (TODAY.getTime() - Date.parse(p.checkOut)) / 86400000;
    expect(open.some((p) => daysSince(p) <= 30)).toBe(true);
    expect(open.some((p) => daysSince(p) > 30)).toBe(true);
  });
});

describe("seed:demo guards", () => {
  const script = path.join(__dirname, "..", "..", "scripts", "seed-demo.js");
  const run = (env, args = []) =>
    spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 20000,
    });

  test("the npm script exists", () => {
    expect(require("../../package.json").scripts["seed:demo"]).toBe("node scripts/seed-demo.js");
  });

  test("options: --reset, --rotate-passwords and --yes only", () => {
    expect(parseArgs([])).toEqual({ reset: false, rotatePasswords: false, yes: false });
    expect(parseArgs(["--reset", "--yes", "--rotate-passwords"])).toEqual({
      reset: true,
      rotatePasswords: true,
      yes: true,
    });
    expect(() => parseArgs(["--drop"])).toThrow(/Unknown argument/);
  });

  test("which databases count as this computer", () => {
    for (const uri of [
      "mongodb://localhost:27017/dimora",
      "mongodb://127.0.0.1/dimora",
      "mongodb://user:pass@127.0.0.1:27017/dimora?authSource=admin",
      "mongodb://[::1]:27017/dimora",
    ]) {
      expect({ uri, local: isLocalUri(uri) }).toEqual({ uri, local: true });
    }
    for (const uri of [
      "mongodb+srv://u:pass@cluster0.example.net/dimora",
      "mongodb://db.example.com:27017/dimora",
      "mongodb://localhost:27017,db.example.com:27017/dimora",
      "mongodb://localhost.evil.example/dimora",
      "mongodb://u:pass@evil.example:1/x?y=@localhost",
    ]) {
      expect({ uri, local: isLocalUri(uri) }).toEqual({ uri, local: false });
    }
  });

  test("the printed target never shows credentials or options", () => {
    const shown = describeTarget("mongodb+srv://alice:secret@cluster0.example.net/dimora?retryWrites=true&w=majority");
    expect(shown).toBe("cluster0.example.net/dimora");
    expect(shown).not.toMatch(/alice|secret|retryWrites/);
    expect(describeTarget("mongodb://127.0.0.1:27017")).toBe("127.0.0.1:27017/(default database)");
  });

  test("NODE_ENV=production exits non-zero before anything else", () => {
    const result = run({ NODE_ENV: "production", MONGODB_URI: "mongodb://127.0.0.1:1/never-connected" }, ["--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/production/);
    expect(result.stdout).not.toMatch(/Target database/);
  });

  test("a remote database is refused without --yes, naming the target but not the credentials", () => {
    const result = run({
      NODE_ENV: "development",
      MONGODB_URI: "mongodb+srv://alice:secret@cluster0.example.net/dimora",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("cluster0.example.net/dimora");
    expect(result.stderr).toMatch(/--yes/);
    expect(result.stdout + result.stderr).not.toMatch(/alice|secret/);
  });

  test("no MONGODB_URI is a plain message, not a stack trace", () => {
    const result = run({ NODE_ENV: "development", MONGODB_URI: "", ATLASDB_URL: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/MONGODB_URI/);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});
