// P18-T03: colour contrast of the design tokens (public/css/tokens.css), by the
// WCAG 2.x formula. axe cannot judge colours in jsdom (no layout), so the pairs
// the pages really use are checked here:
//   text: 4.5:1 (WCAG 1.4.3);   non-text parts (control outlines, the focus
//   ring, icons): 3:1 (1.4.11).
// A new token pair that is used for text should be added to TEXT_PAIRS.
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "css", "tokens.css"),
  "utf8",
);

// --name: value;  (the first declaration of a name wins: the light theme)
const tokens = new Map();
for (const m of css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm))
  if (!tokens.has(m[1]))
    tokens.set(m[1], m[2].trim().replace(/\s*\/\*.*$/, ""));

function resolve(name, depth = 0) {
  if (depth > 8) throw new Error(`token loop at ${name}`);
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`unknown token ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  return ref ? resolve(ref[1], depth + 1) : raw;
}

function rgb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) throw new Error(`not a plain #rrggbb colour: ${value}`);
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function ratio(fgToken, bgToken) {
  const [a, b] = [
    luminance(rgb(resolve(fgToken))),
    luminance(rgb(resolve(bgToken))),
  ];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = [
  "--color-surface",
  "--color-surface-raised",
  "--color-surface-sunken",
];
const TEXT_PAIRS = [
  // body and muted text, on every surface
  ...SURFACES.flatMap((s) => [
    ["--color-text", s],
    ["--color-text-muted", s],
    ["--color-link", s],
    ["--color-link-hover", s],
    ["--color-danger", s],
    ["--color-danger-hover", s],
  ]),
  ["--color-accent", "--color-surface"],
  ["--color-accent", "--color-surface-raised"],
  ["--color-accent-hover", "--color-surface-raised"],
  ["--color-success", "--color-surface-raised"],
  ["--color-success", "--color-surface"],
  // text on buttons
  ["--color-on-primary", "--color-primary"],
  ["--color-on-primary", "--color-primary-hover"],
  ["--color-on-accent", "--color-accent"],
  ["--color-on-accent", "--color-accent-hover"],
  // text on the subtle primary fill and on badges
  ["--color-primary", "--color-primary-subtle"],
  ["--color-text", "--color-primary-subtle"],
  ...["neutral", "primary", "accent", "success", "warning", "danger"].map(
    (v) => [`--color-badge-${v}-text`, `--color-badge-${v}-bg`],
  ),
];
const NON_TEXT_PAIRS = [
  ...SURFACES.flatMap((s) => [
    ["--color-border-strong", s],
    ["--color-focus", s],
  ]),
  ["--color-primary", "--color-surface"],
  ["--color-star", "--color-surface"],
  ["--color-star", "--color-surface-raised"],
];

describe("colour contrast of the design tokens", () => {
  test("the token file was read", () => {
    expect(tokens.size).toBeGreaterThan(40);
    expect(resolve("--color-text")).toBe("#1b2a2f");
  });

  test("the formula agrees with known values", () => {
    expect(ratio("--palette-white", "--palette-white")).toBeCloseTo(1, 5);
    tokens.set("--t-black", "#000000");
    tokens.set("--t-white", "#ffffff");
    expect(ratio("--t-black", "--t-white")).toBeCloseTo(21, 1);
    tokens.set("--t-grey", "#777777"); // the classic 4.48:1 on white
    expect(ratio("--t-grey", "--t-white")).toBeCloseTo(4.48, 1);
  });

  test.each(TEXT_PAIRS)("text %s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(NON_TEXT_PAIRS)(
    "outline/icon %s against %s is at least 3:1",
    (fg, bg) => {
      expect(ratio(fg, bg)).toBeGreaterThanOrEqual(3);
    },
  );
});
