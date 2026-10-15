// P03-T01: the CSS architecture rules, checked as files (no browser needed).
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const CSS_DIR = path.join(ROOT, "public", "css");
const VIEWS_DIR = path.join(ROOT, "views");
const read = (file) => fs.readFileSync(file, "utf8");
const cssFiles = () =>
  fs.readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

// Strings that carry colour in CSS. A "#id" selector is not a colour, so a hex
// value must follow a colon, comma, paren or space (a value position).
const COLOUR_PATTERNS = [
  [
    /(^|[\s:(,])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/,
    "hex colour",
  ],
  [/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/i, "colour function"],
  [
    /:\s*(?:white|black|gold|red|blue|green|yellow|orange|grey|gray)\b/i,
    "named colour",
  ],
];
// Animation times belong to tokens so reduced motion can switch them off.
const TIME_PATTERN = /(?:transition|animation)[^;{}]*\b\d*\.?\d+m?s\b/i;

function violations(css) {
  const clean = stripComments(css).replace(/url\("[^"]*"\)/g, "url()");
  const found = [];
  for (const [re, label] of COLOUR_PATTERNS) {
    const m = clean.match(re);
    if (m) found.push(`${label}: ${m[0].trim()}`);
  }
  const t = clean.match(TIME_PATTERN);
  if (t) found.push(`literal time: ${t[0].trim()}`);
  return found;
}

describe("file layout", () => {
  test("tokens.css, base.css and components.css exist; the old style.css is gone", () => {
    const files = cssFiles();
    for (const f of ["tokens.css", "base.css", "components.css"]) {
      expect(files).toContain(f);
    }
    expect(files).not.toContain("style.css");
  });

  test("the layout loads them after Bootstrap and in token -> base -> components order", () => {
    const layout = read(path.join(VIEWS_DIR, "layouts", "boilerPlate.ejs"));
    const at = (needle) => layout.indexOf(needle);
    const order = [
      "bootstrap.min.css",
      "/css/tokens.css",
      "/css/base.css",
      "/css/components.css",
      "/css/rating.css",
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(layout).not.toContain("/css/style.css");
  });
});

describe("no hard-coded values outside tokens.css", () => {
  const others = () => cssFiles().filter((f) => f !== "tokens.css");

  test.each(["base.css", "components.css", "rating.css"])(
    "%s has no colours or literal animation times",
    (file) => {
      expect(violations(read(path.join(CSS_DIR, file)))).toEqual([]);
    },
  );

  test("every other stylesheet in public/css is clean too", () => {
    for (const file of others()) {
      expect({
        file,
        found: violations(read(path.join(CSS_DIR, file))),
      }).toEqual({ file, found: [] });
    }
  });

  test("the checker really catches violations (and ignores #id selectors)", () => {
    expect(violations("a { color: #fe424d; }")).toHaveLength(1);
    expect(violations("a { color:#abc }")).toHaveLength(1);
    expect(violations("a { background: rgba(0,0,0,.2); }")).toHaveLength(1);
    expect(violations("a { color: white; }")).toHaveLength(1);
    expect(violations("a { transition: color 0.2s ease; }")).toHaveLength(1);
    expect(violations("#map { height: 4rem; } #filters { gap: 1rem }")).toEqual(
      [],
    );
    expect(violations("/* #fe424d */ a { color: var(--color-text); }")).toEqual(
      [],
    );
  });

  test("tokens.css is where the values are", () => {
    const tokens = read(path.join(CSS_DIR, "tokens.css"));
    expect(tokens).toMatch(/#[0-9a-f]{6}/i);
    expect(tokens).toMatch(/--duration-base:\s*\d+ms/);
  });
});

describe("tokens", () => {
  const tokens = stripComments(read(path.join(CSS_DIR, "tokens.css")));
  const defined = new Set(
    [...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );

  test.each([
    "--color-text",
    "--color-surface",
    "--color-primary",
    "--color-accent",
    "--space-1",
    "--space-4",
    "--space-8",
    "--radius-sm",
    "--radius-lg",
    "--shadow-sm",
    "--shadow-lg",
    "--font-size-sm",
    "--font-size-2xl",
    "--font-family-base",
    "--duration-fast",
    "--duration-base",
    "--duration-slow",
  ])("defines %s", (name) => {
    expect(defined.has(name)).toBe(true);
  });

  test("every var(--x) used in base, components and rating is defined", () => {
    const missing = [];
    for (const file of ["base.css", "components.css", "rating.css"]) {
      const css = stripComments(read(path.join(CSS_DIR, file)));
      for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!defined.has(m[1])) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("base.css switches all motion off for prefers-reduced-motion", () => {
    const base = stripComments(read(path.join(CSS_DIR, "base.css")));
    const block = base.match(
      /@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\n}\n/,
    );
    expect(block).not.toBeNull();
    for (const name of [
      "--duration-fast",
      "--duration-base",
      "--duration-slow",
    ]) {
      expect(block[0]).toMatch(new RegExp(`${name}:\\s*0ms`));
    }
  });

  test("the semantic colour layer is the only thing components use (no --palette-* outside tokens.css)", () => {
    for (const file of ["base.css", "components.css", "rating.css"]) {
      expect(read(path.join(CSS_DIR, file))).not.toMatch(/--palette-/);
    }
  });
});

// ---- Contrast (WCAG 2.x relative luminance) --------------------------------
function resolve(name, tokens, depth = 0) {
  const m = tokens.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token ${name} not found`);
  const value = m[1].trim();
  const ref = value.match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref) {
    if (depth > 5) throw new Error(`token loop at ${name}`);
    return resolve(ref[1], tokens, depth + 1);
  }
  return value;
}
function luminance(hex) {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("colour contrast", () => {
  const tokens = stripComments(read(path.join(CSS_DIR, "tokens.css")));
  const c = (name) => resolve(name, tokens);

  const TEXT_PAIRS = [
    ["--color-text", "--color-surface"],
    ["--color-text", "--color-surface-raised"],
    ["--color-text", "--color-surface-sunken"],
    ["--color-text-muted", "--color-surface"],
    ["--color-text-muted", "--color-surface-raised"],
    ["--color-text-muted", "--color-surface-sunken"],
    ["--color-on-primary", "--color-primary"],
    ["--color-on-primary", "--color-primary-hover"],
    ["--color-on-accent", "--color-accent"],
    ["--color-on-accent", "--color-accent-hover"],
    ["--color-link", "--color-surface"],
    ["--color-link", "--color-surface-raised"],
    ["--color-link-hover", "--color-surface"],
    ["--color-accent", "--color-surface"],
    ["--color-accent", "--color-surface-raised"],
    ["--color-primary", "--color-surface-sunken"],
    ["--color-danger", "--color-surface-raised"],
    ["--color-on-primary", "--color-danger"],
    ["--color-on-primary", "--color-danger-hover"],
    ["--color-badge-neutral-text", "--color-badge-neutral-bg"],
    ["--color-badge-primary-text", "--color-badge-primary-bg"],
    ["--color-badge-accent-text", "--color-badge-accent-bg"],
    ["--color-badge-success-text", "--color-badge-success-bg"],
    ["--color-badge-warning-text", "--color-badge-warning-bg"],
    ["--color-badge-danger-text", "--color-badge-danger-bg"],
    ["--color-success", "--color-surface-raised"],
  ];
  const UI_PAIRS = [
    ["--color-border-strong", "--color-surface-raised"],
    ["--color-border-strong", "--color-surface"],
    ["--color-focus", "--color-surface"],
    ["--color-focus", "--color-surface-raised"],
    ["--color-star", "--color-surface-raised"],
    ["--color-star", "--color-surface"],
  ];

  test.each(TEXT_PAIRS)("text %s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(c(fg), c(bg))).toBeGreaterThanOrEqual(4.5);
  });

  test.each(UI_PAIRS)("UI colour %s against %s is at least 3:1", (fg, bg) => {
    expect(ratio(c(fg), c(bg))).toBeGreaterThanOrEqual(3);
  });

  test("the ratio function agrees with known values (black/white = 21)", () => {
    expect(Math.round(ratio("#000000", "#ffffff"))).toBe(21);
    expect(ratio("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("views carry no inline styles (D-18 and P03-T01)", () => {
  const views = walk(VIEWS_DIR).filter((f) => f.endsWith(".ejs"));

  test("there are views to check", () => {
    expect(views.length).toBeGreaterThan(5);
  });

  test('no <style> blocks and no style="" attributes', () => {
    const offenders = [];
    for (const file of views) {
      const text = read(file);
      if (/<style[\s>]/i.test(text))
        offenders.push(`${path.relative(ROOT, file)}: <style>`);
      if (/\sstyle\s*=/i.test(text))
        offenders.push(`${path.relative(ROOT, file)}: style=`);
    }
    expect(offenders).toEqual([]);
  });

  test("no hard-coded hex colour inside a view", () => {
    const offenders = [];
    for (const file of views) {
      const text = read(file).replace(/&#\d+;|&#x[0-9a-f]+;/gi, "");
      if (
        /(^|[\s:(,"'])#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/.test(
          text.replace(/href="#[^"]*"/g, ""),
        )
      ) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("D-18: layout defects", () => {
  const base = read(path.join(CSS_DIR, "base.css"));
  const components = read(path.join(CSS_DIR, "components.css"));

  test("#map is fluid, not a fixed 80vh width", () => {
    const rule = base.match(/#map\s*{[^}]*}/)[0];
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).not.toMatch(/vh/);
  });

  test("no invalid '5 rem' length remains", () => {
    expect(base + components).not.toMatch(/\d\s+rem\b/);
  });

  test("login, signup and error views use a responsive column, not col-6 offset-3", () => {
    for (const file of ["users/login.ejs", "users/signup.ejs", "error.ejs"]) {
      const text = read(path.join(VIEWS_DIR, file));
      expect(text).not.toMatch(/col-6 offset-3/);
      expect(text).toMatch(/col-12 col-md-8 col-lg-6 mx-auto/);
    }
  });
});
