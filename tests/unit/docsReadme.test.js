// P19-T01: the README says things that can be checked, so they are checked: the
// environment table against the settings code and .env.example, the scripts
// table against package.json, the Node version, the links, the diagrams
// against the models, and that no secret slipped in.
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const readme = read("README.md");
const pkg = JSON.parse(read("package.json"));

const section = (title) => {
  const start = readme.indexOf(`## ${title}`);
  expect(start).toBeGreaterThan(-1);
  const next = readme.indexOf("\n## ", start + 5);
  return readme.slice(start, next === -1 ? undefined : next);
};

describe("README structure", () => {
  test("has every part the task asks for", () => {
    for (const title of [
      "What works",
      "What is simulated",
      "Install",
      "Environment",
      "Database",
      "Scripts",
      "Tests",
      "Architecture",
      "Data model",
      "API",
      "Known limitations",
    ]) {
      expect(readme).toMatch(new RegExp(`^## ${title}$`, "m"));
    }
  });
  test("states plainly that payments are simulated and refunds only recorded", () => {
    const text = section("What is simulated");
    expect(text).toMatch(/Payments\./);
    expect(text).toMatch(/nothing is charged/);
    expect(text).toMatch(/no money moves/);
    expect(text).toMatch(/Nothing is ever sent/);
  });
});

describe("environment table", () => {
  const table = section("Environment");
  const readmeKeys = [...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map(
    (m) => m[1],
  );
  const code = read("src/config/env.js");
  const keysInCode = [
    ...code
      .slice(
        code.indexOf("const KEYS"),
        code.indexOf("];", code.indexOf("const KEYS")),
      )
      .matchAll(/"([A-Z_]+)"/g),
  ].map((m) => m[1]);
  const example = [
    ...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z_]+)=/gm),
  ].map((m) => m[1]);

  test("lists exactly the keys the settings code reads", () => {
    expect(readmeKeys.sort()).toEqual([...keysInCode].sort());
  });
  test(".env.example has every key too", () => {
    expect(keysInCode.filter((k) => !example.includes(k))).toEqual([]);
  });
  test("what it says is required is required, and the defaults are the code's", () => {
    const { validateEnv } = require("../../src/config/env");
    const valid = {
      MONGODB_URI: "mongodb://127.0.0.1:27017/x",
      SESSION_SECRET: "a".repeat(40),
      CLOUDINARY_CLOUD_NAME: "c",
      CLOUDINARY_API_KEY: "k",
      CLOUDINARY_API_SECRET: "s",
      MAPBOX_SERVER_TOKEN: "sk.server",
      MAPBOX_PUBLIC_TOKEN: "pk.public",
    };
    const config = validateEnv(valid);
    expect(config.port).toBe(8080);
    expect(config.sweeper).toEqual({ enabled: true, intervalMs: 60000 });
    expect(config.reviews.windowDays).toBe(30);
    for (const line of table.split("\n").filter((l) => /^\| `/.test(l))) {
      const [, key, required, fallback] = line.split("|").map((c) => c.trim());
      const name = key.replace(/`/g, "");
      if (required === "yes") {
        const without = { ...valid };
        delete without[name];
        expect({
          name,
          refused: (() => {
            try {
              validateEnv(without);
              return false;
            } catch {
              return true;
            }
          })(),
        }).toEqual({ name, refused: true });
      }
      if (fallback === "`8080`") expect(config.port).toBe(8080);
      if (fallback === "`60`") expect(config.sweeper.intervalMs).toBe(60000);
      if (fallback === "`30`") expect(config.reviews.windowDays).toBe(30);
    }
  });
  test("the legacy names it mentions are the ones the code still accepts", () => {
    const text = table.slice(table.indexOf("Old names"));
    for (const legacy of [
      "ATLASDB_URL",
      "CLOUD_NAME",
      "CLOUD_API_KEY",
      "CLOUD_API_SECRET",
      "MAP_TOKEN",
    ]) {
      expect(text).toContain(legacy);
      expect(code).toContain(`"${legacy}"`);
    }
  });
});

describe("scripts table", () => {
  test("every npm script is in the table, with the command a person types, and nothing else is", () => {
    const listed = [
      ...section("Scripts").matchAll(
        /^\| `(npm (?:run )?[a-z:-]+)(?: [^`]*)?` \|/gm,
      ),
    ].map((m) => m[1].replace(/^npm (run )?/, ""));
    expect(listed.sort()).toEqual(Object.keys(pkg.scripts).sort());
    expect(section("Scripts")).toContain("npm run make-admin -- <email>");
  });
  test("the commands in the Install and Database sections exist", () => {
    for (const name of [
      "dev",
      "migrate",
      "migrate:dry",
      "seed",
      "make-admin",
      "test",
    ])
      expect(pkg.scripts[name]).toBeTruthy();
  });
});

describe("facts", () => {
  test("the Node version is the engines field", () => {
    expect(pkg.engines.node).toBe(">=20.19.0");
    expect(readme).toContain("Node.js 20.19 or newer");
  });
  test("the seed numbers are the seed's", () => {
    expect(require("../../scripts/seed-data").data).toHaveLength(29);
    expect(readme).toContain("29 sample listings");
    expect(read("scripts/seed.js")).toContain("dimora_demo_host");
  });
  test("the sweeper description matches its defaults", () => {
    const { DEFAULTS } = require("../../src/services/sweeper");
    expect(DEFAULTS.draftDays).toBe(90);
    expect(readme).toContain("untouched for 90 days");
    expect(readme).toContain("24 hours");
  });
  test("every relative link points at a file or folder that exists", () => {
    const links = [...readme.matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)].map(
      (m) => m[1].split("#")[0],
    );
    expect(links.length).toBeGreaterThan(15);
    expect(links.filter((l) => !fs.existsSync(path.join(ROOT, l)))).toEqual([]);
  });
  test("no secret and no invented address is written in it", () => {
    expect(readme).not.toMatch(/mongodb(\+srv)?:\/\/[^<\s]+:[^<\s]+@/);
    expect(readme).not.toMatch(/\b(sk|pk)\.[A-Za-z0-9]{20,}/);
    expect(readme).not.toMatch(/github\.com\/[A-Za-z0-9-]+\/Dimora/);
    expect(readme).not.toMatch(/api[_-]?secret\s*[=:]\s*\S{12,}/i);
  });
});

describe("diagrams", () => {
  const blocks = [...readme.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(
    (m) => m[1],
  );
  test("there are two, an architecture flowchart and an entity diagram", () => {
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatch(/^flowchart LR/);
    expect(blocks[1]).toMatch(/^erDiagram/);
  });
  test("the flowchart's boxes and arrows balance (every id used is declared or is a plain id)", () => {
    expect((blocks[0].match(/\bsubgraph\b/g) || []).length).toBe(
      (blocks[0].match(/^\s*end$/gm) || []).length,
    );
    for (const word of [
      "Express",
      "Controllers",
      "Services",
      "Models",
      "Mongo",
      "Cloudinary",
      "Sweeper",
      "MapboxGL",
    ])
      expect(blocks[0]).toContain(word);
  });
  test("the data model shows every collection and every reference the models declare", () => {
    const er = blocks[1];
    const entities = {
      User: "USER",
      Listing: "LISTING",
      Reservation: "RESERVATION",
      StayNight: "STAYNIGHT",
      AvailabilityBlock: "AVAILABILITYBLOCK",
      Review: "REVIEW",
      Report: "REPORT",
      AuditLog: "AUDITLOG",
    };
    const connected = (a, b) =>
      new RegExp(
        `${a} [|}o][|o]--[o|][|{] ${b}|${b} [|}o][|o]--[o|][|{] ${a}`,
      ).test(er);
    for (const [model, entity] of Object.entries(entities)) {
      expect(
        mongoose.models[model] ||
          require(
            `../../src/models/${model.charAt(0).toLowerCase()}${model.slice(1)}`,
          ),
      ).toBeTruthy();
      expect({
        entity,
        declared: new RegExp(`^  ${entity} \\{`, "m").test(er),
      }).toEqual({ entity, declared: true });
    }
    // references found in the schemas, as [from model, to model]
    const refs = new Set();
    for (const model of Object.keys(entities)) {
      const M = require(
        `../../src/models/${model.charAt(0).toLowerCase()}${model.slice(1)}`,
      );
      M.schema.eachPath((p, type) => {
        const ref =
          (type.options && type.options.ref) ||
          (type.caster && type.caster.options && type.caster.options.ref);
        if (ref && entities[ref] && ref !== model)
          refs.add([model, ref].sort().join("|"));
      });
    }
    expect(refs.size).toBeGreaterThanOrEqual(7);
    for (const pair of refs) {
      const [a, b] = pair.split("|");
      expect({ pair, drawn: connected(entities[a], entities[b]) }).toEqual({
        pair,
        drawn: true,
      });
    }
    // a night is held by a reservation or a block (a polymorphic source, not a ref), and reports point anywhere
    expect(connected("RESERVATION", "STAYNIGHT")).toBe(true);
    expect(connected("AVAILABILITYBLOCK", "STAYNIGHT")).toBe(true);
    expect(er).toContain("string targetKind");
  });
});
