// P19-T04: docs/DEMO.md says things that can be checked, so they are checked:
// commands, files, routes, accounts, places and the worked price example.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const demo = read("docs/DEMO.md");
const shots = read("docs/demo/SHOTS.md");
const pkg = JSON.parse(read("package.json"));

describe("docs/DEMO.md", () => {
  test("has the parts the task asks for", () => {
    for (const title of [
      "The five-minute walkthrough",
      "Engineering highlights",
      "Honest limitations",
    ]) {
      expect(demo).toMatch(new RegExp(`^## \\d+\\. ${title}`, "m"));
    }
    expect(demo).toMatch(/### The night ledger/);
    expect(demo).toMatch(/### The quote engine/);
    expect(demo).toMatch(/### Authorization/);
  });

  test("every npm script it names exists", () => {
    const names = [...demo.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(2);
    expect(names.filter((n) => !pkg.scripts[n])).toEqual([]);
  });

  test("every relative link and test file it names exists", () => {
    const links = [...demo.matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)].map((m) =>
      m[1].replace(/#.*$/, ""),
    );
    expect(links.length).toBeGreaterThan(5);
    const missing = links.filter(
      (l) => !fs.existsSync(path.join(ROOT, "docs", l)),
    );
    expect(missing).toEqual([]);
    const files = [
      ...demo.matchAll(/\b((?:tests|src|scripts)\/[\w./-]+\.js)\b/g),
    ].map((m) => m[1]);
    expect(files.filter((f) => !fs.existsSync(path.join(ROOT, f)))).toEqual([]);
  });

  test("every route in the routes table is served by the app", () => {
    const { listRoutes } = require("../../src/utils/routeList");
    const have = new Set(listRoutes().map((r) => `${r.method} ${r.path}`));
    const used = [...demo.matchAll(/^\| `(GET|POST) (\/[^`]*)` \|/gm)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((r) => !have.has(r))).toEqual([]);
  });

  test("the demo accounts are the ones the seed makes", () => {
    const { DEMO_ACCOUNTS } = require("../../scripts/demo-data");
    for (const account of Object.values(DEMO_ACCOUNTS)) {
      expect(demo).toContain(`\`${account.username}\``);
    }
  });

  test("the two places are as described and have no seeded booking", () => {
    const { buildDemoListings, SCENARIOS } = require("../../scripts/demo-data");
    const places = buildDemoListings("owner");
    const get = (t) => places.find((p) => p.title === t);
    const cottage = get("Charming Cottage in the Cotswolds");
    const villa = get("Historic Villa in Tuscany");
    expect(cottage).toMatchObject({
      instantBook: true,
      minNights: 2,
      cancellationPolicy: "moderate",
    });
    expect(cottage.pricing).toMatchObject({
      nightlyMinor: 120000,
      cleaningFeeMinor: 12000,
    });
    expect(cottage.pricing.weekendNightlyMinor).toBeUndefined();
    expect(villa).toMatchObject({
      instantBook: false,
      minNights: 3,
      cancellationPolicy: "strict",
    });
    expect(villa.pricing).toMatchObject({
      nightlyMinor: 250000,
      cleaningFeeMinor: 40000,
    });
    const booked = SCENARIOS.map((s) => s.listing);
    expect(booked).not.toContain(cottage.title);
    expect(booked).not.toContain(villa.title);
    expect(demo).toContain("Luxury Penthouse with City Views");
    expect(booked).toContain("Luxury Penthouse with City Views");
    // "three finished stays for the guest"
    expect(
      SCENARIOS.filter((s) => s.guest === "guest" && s.final === "completed"),
    ).toHaveLength(3);
  });

  test("the worked price example is what the quote engine returns", () => {
    const { quote } = require("../../src/services/pricing");
    const { parseDateOnly } = require("../../src/utils/dates");
    const { buildDemoListings } = require("../../scripts/demo-data");
    const cottage = buildDemoListings("o").find(
      (p) => p.title === "Charming Cottage in the Cotswolds",
    );
    // 2026-12-07 is a Monday: Mon, Tue, Wed nights.
    const q = quote({
      listing: cottage,
      checkIn: parseDateOnly("2026-12-07"),
      checkOut: parseDateOnly("2026-12-10"),
      guests: 2,
    });
    const by = Object.fromEntries(q.lines.map((l) => [l.code, l.amountMinor]));
    expect(by).toEqual({
      nights: 360000,
      cleaning: 12000,
      service_fee: 37200,
      tax: 66960,
    });
    expect(q.totalMinor).toBe(476160);
    for (const text of [
      "360,000",
      "12,000",
      "37,200",
      "66,960",
      "476,160",
      "4,761.60",
    ]) {
      expect(demo).toContain(text);
    }
    expect(shots).toContain("4,761.60");
  });

  test("beach and city places have a higher weekend price, as it says", () => {
    const { buildDemoListings } = require("../../scripts/demo-data");
    const p = buildDemoListings("o").find(
      (x) => x.title === "Beachfront Paradise",
    );
    expect(p.pricing.weekendNightlyMinor).toBeGreaterThan(
      p.pricing.nightlyMinor,
    );
  });

  test("it says routers are unreachable only while that is true", () => {
    // If one of these gets mounted, this fails: update section 5 of DEMO.md.
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".js")) files.push(p);
      }
    })(path.join(ROOT, "src"));
    const source = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    for (const router of ["conversations", "notifications", "account"]) {
      expect(source).not.toMatch(
        new RegExp(`require\\(["'][^"']*routes/${router}["']\\)`),
      );
    }
  });

  test("it makes no claim of screenshots and lists the pictures to take", () => {
    expect(demo).toMatch(/does not contain: screenshots or GIFs/);
    const names = [...shots.matchAll(/^\| `([\w.-]+\.(?:png|gif))`/gm)].map(
      (m) => m[1],
    );
    expect(names.length).toBeGreaterThanOrEqual(10);
    const dir = path.join(ROOT, "docs", "demo");
    expect(names.filter((n) => fs.existsSync(path.join(dir, n)))).toEqual([]);
  });

  test("README links to it", () => {
    expect(read("README.md")).toContain("](docs/DEMO.md)");
  });
});
