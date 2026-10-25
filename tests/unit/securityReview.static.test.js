// P17-T02: standing checks of the input and injection review. They read the
// source files (no server, no database): a new raw-output sink, a new unsafe
// DOM call or a new upload route without the input guard fails here.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const walk = (dir, ext, out = []) => {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(rel, ext, out);
    } else if (entry.name.endsWith(ext)) out.push(rel);
  }
  return out;
};

describe("views: raw (unescaped) output", () => {
  // Every <%- %> in a view must be one of these, each for a stated reason.
  const ALLOWED = [
    [/^include\(/, "includes another template"],
    [/^body$/, "the page content inside the layout (ejs-mate)"],
    [/^current\(/, "helper returning a fixed attribute string for the nav link"],
    [/^range\.(from|to)$/, "page numbers (numbers computed on the server)"],
    [/^destText$/, "built in views/listings/index.ejs with every & < > \" ' escaped"],
    [/^structuredData$/, "JSON-LD: must be built with src/utils/jsonLd.js; currently never set"],
  ];

  test("only the allow-listed expressions are printed raw", () => {
    const offenders = [];
    for (const file of walk("views", ".ejs")) {
      const source = read(file).replace(/<%#[\s\S]*?%>/g, ""); // comments may mention <%- %>
      for (const match of source.matchAll(/<%-\s*([\s\S]*?)\s*%>/g)) {
        const expression = match[1].trim();
        if (!ALLOWED.some(([pattern]) => pattern.test(expression))) {
          offenders.push(`${file}: <%- ${expression.slice(0, 60)} %>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("template comments never contain a tag: EJS ends a comment at the first closing tag, so the rest would be printed into the page", () => {
    const offenders = [];
    for (const file of walk("views", ".ejs")) {
      for (const match of read(file).matchAll(/<%#([\s\S]*?)%>/g)) {
        if (match[1].includes("<%")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("destText really escapes all five characters", () => {
    const line = read("views", "listings", "index.ejs").split("\n").find((l) => l.includes("const destText"));
    for (const piece of ['"&amp;"', '"&lt;"', '"&gt;"', '"&quot;"', '"&#39;"']) {
      expect(line.includes(piece)).toBe(true);
    }
  });

  test("no inline event handlers and no javascript: links in views", () => {
    const offenders = [];
    for (const file of walk("views", ".ejs")) {
      const source = read(file).replace(/<%[\s\S]*?%>/g, "");
      if (/\son[a-z]+\s*=\s*["']/i.test(source)) offenders.push(`${file}: inline handler`);
      if (/javascript:/i.test(source)) offenders.push(`${file}: javascript: URL`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("browser scripts", () => {
  test("none builds HTML from strings or evaluates text", () => {
    const offenders = [];
    for (const file of walk(path.join("public", "js"), ".js")) {
      const source = read(file);
      if (/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("input guard coverage", () => {
  test("app.js parses forms with the shared options and runs the guard right after", () => {
    const app = read("src", "app.js");
    expect(app.includes("express.urlencoded(URLENCODED_OPTIONS)")).toBe(true);
    expect(app.indexOf("app.use(inputGuard)")).toBeGreaterThan(app.indexOf("express.urlencoded(URLENCODED_OPTIONS)"));
    expect(/express\.urlencoded\(\s*\{/.test(app)).toBe(false); // no second parser with other options
  });

  test("every route file that uses multer runs the guard after it", () => {
    const offenders = [];
    for (const file of walk(path.join("src", "routes"), ".js")) {
      const source = read(file);
      const uses = [...source.matchAll(/\b(upload|uploadPhotos)\.(single|array|fields|any)\([^)]*\),?\s*\n\s*(\w+)/g)];
      for (const use of uses) {
        if (use[3] !== "inputGuard") offenders.push(`${file}: ${use[0].split("\n")[0].trim()} is not followed by inputGuard`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("multer limits cover text fields, not only files", () => {
    const config = read("src", "config", "cloudinary.js");
    expect(/fieldSize:\s*100\s*\*\s*1024/.test(config)).toBe(true);
    expect(/fields:\s*100/.test(config)).toBe(true);
  });
});
