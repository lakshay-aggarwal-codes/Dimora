// P18-T04: what can be checked about narrow screens and motion without a
// browser. The CSS is read as data (rules with the media query they sit in) and
// the scripts and views as text. A real browser walk at 360/414/768/1024/1440
// is in docs/RESPONSIVE.md; this keeps the rules that make that walk pass from
// being undone by accident.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const css = {
  tokens: read("public/css/tokens.css"),
  base: read("public/css/base.css"),
  components: read("public/css/components.css"),
  rating: read("public/css/rating.css"),
};

// ---- a small CSS reader: rules with their media query, @keyframes apart ----
function parseCss(text) {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const keyframes = [];
  function block(from, media) {
    let i = from;
    while (i < source.length) {
      const open = source.indexOf("{", i);
      const close = source.indexOf("}", i);
      if (close !== -1 && (open === -1 || close < open)) return close + 1;
      if (open === -1) return source.length;
      const head = source.slice(i, open).trim();
      if (head.startsWith("@media")) {
        i = block(open + 1, head.replace(/^@media\s*/, ""));
      } else if (head.startsWith("@keyframes")) {
        // skip the steps (0%, 50%...): they are not rules about elements
        let depth = 1;
        let end = open + 1;
        while (depth > 0 && end < source.length) {
          if (source[end] === "{") depth += 1;
          if (source[end] === "}") depth -= 1;
          end += 1;
        }
        keyframes.push(head.replace("@keyframes", "").trim());
        i = end;
      } else if (head.startsWith("@")) {
        i = block(open + 1, media); // @font-face, @supports...: read inside
      } else {
        const end = source.indexOf("}", open);
        const body = source.slice(open + 1, end);
        const declarations = {};
        for (const part of body.split(";")) {
          const colon = part.indexOf(":");
          if (colon > 0)
            declarations[part.slice(0, colon).trim()] = part
              .slice(colon + 1)
              .trim();
        }
        rules.push({
          selector: head.replace(/\s+/g, " "),
          declarations,
          media: media || null,
        });
        i = end + 1;
      }
    }
    return i;
  }
  block(0, null);
  return { rules, keyframes };
}

const parsed = {
  components: parseCss(css.components),
  base: parseCss(css.base),
  rating: parseCss(css.rating),
  tokens: parseCss(css.tokens),
};
const allRules = [
  ...parsed.base.rules,
  ...parsed.components.rules,
  ...parsed.rating.rules,
];
const REDUCE = "(prefers-reduced-motion: reduce)";
const ms = (value) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value.trim());
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : null;
};
const rem = (value) => {
  const m = /^(\d+(?:\.\d+)?)(rem|px)$/.exec(value.trim());
  return m ? (m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1])) : null;
};

describe("motion: nothing that gives feedback is slower than 300 ms", () => {
  const tokens = Object.fromEntries(
    [...css.tokens.matchAll(/(--duration-[a-z]+):\s*([0-9.]+m?s)/g)].map(
      (m) => [m[1], ms(m[2])],
    ),
  );

  test("every duration token is at most 300 ms, except the loading pulse, which is not feedback", () => {
    expect(Object.keys(tokens).sort()).toEqual([
      "--duration-base",
      "--duration-fast",
      "--duration-loading",
      "--duration-slow",
    ]);
    for (const [name, value] of Object.entries(tokens)) {
      if (name === "--duration-loading") continue;
      expect({ name, ok: value <= 300 }).toEqual({ name, ok: true });
    }
    expect(tokens["--duration-loading"]).toBeGreaterThan(300);
  });

  test("every transition and animation uses a token or a literal of at most 300 ms", () => {
    for (const rule of allRules) {
      for (const [prop, value] of Object.entries(rule.declarations)) {
        if (!/^(-webkit-)?(transition|animation)(-duration)?$/.test(prop))
          continue;
        for (const time of value.match(/\b\d+(?:\.\d+)?m?s\b/g) || []) {
          expect({
            selector: rule.selector,
            prop,
            time,
            ok: ms(time) <= 300,
          }).toEqual({ selector: rule.selector, prop, time, ok: true });
        }
        if (/var\(--duration-loading\)/.test(value)) {
          expect({
            selector: rule.selector,
            loadingOnly: /^(\.skeleton|#search-map\.is-loading)$/.test(
              rule.selector,
            ),
          }).toEqual({ selector: rule.selector, loadingOnly: true });
        }
      }
    }
  });

  test("only the loading pulse repeats forever, and the only @keyframes is that pulse", () => {
    for (const rule of allRules) {
      const animation = rule.declarations.animation || "";
      if (/\binfinite\b/.test(animation))
        expect(rule.selector).toMatch(/^(\.skeleton|#search-map\.is-loading)$/);
    }
    expect([
      ...parsed.components.keyframes,
      ...parsed.base.keyframes,
      ...parsed.rating.keyframes,
    ]).toEqual(["skeleton-pulse"]);
  });

  test("the scripts do not animate by themselves: no smooth scrolling, and every map move states its duration", () => {
    for (const file of fs.readdirSync(path.join(ROOT, "public/js"))) {
      const text = read(`public/js/${file}`);
      expect({ file, smooth: /behavior:\s*["']smooth["']/.test(text) }).toEqual(
        { file, smooth: false },
      );
      for (const call of text.match(
        /\.(easeTo|flyTo|fitBounds|panTo|zoomTo)\(/g,
      ) || []) {
        expect(call).toBeTruthy();
      }
    }
    const map = read("public/js/searchMap.js");
    const moves =
      map.match(/map\.(easeTo|flyTo|fitBounds)\([\s\S]*?\);/g) || [];
    expect(moves.length).toBeGreaterThanOrEqual(3);
    for (const move of moves) expect(move).toMatch(/duration:\s*(0|MOVE_MS)\b/);
    const move = Number(
      /const MOVE_MS = reducedMotion \? 0 : (\d+);/.exec(map)[1],
    );
    expect(move).toBeLessThanOrEqual(300);
  });
});

describe("motion: prefers-reduced-motion is honoured", () => {
  test("the base layer zeroes every duration token and turns smooth scrolling off", () => {
    const reduce = parsed.base.rules.filter((r) => r.media === REDUCE);
    const root = reduce.find((r) => r.selector === ":root");
    expect(root.declarations).toEqual({
      "--duration-fast": "0ms",
      "--duration-base": "0ms",
      "--duration-slow": "0ms",
    });
    const scroll = reduce.find(
      (r) => r.declarations["scroll-behavior"] === "auto",
    );
    expect(scroll.selector).toMatch(/html/);
  });

  test("every element that scrolls smoothly is named in that block", () => {
    const reduce = parsed.base.rules
      .filter(
        (r) =>
          r.media === REDUCE && r.declarations["scroll-behavior"] === "auto",
      )
      .map((r) => r.selector)
      .join(" ");
    const smooth = allRules.filter(
      (r) =>
        r.media !== REDUCE &&
        /smooth/.test(r.declarations["scroll-behavior"] || ""),
    );
    expect(smooth.length).toBeGreaterThan(0);
    for (const rule of smooth)
      expect({
        selector: rule.selector,
        covered: reduce.includes(rule.selector),
      }).toEqual({ selector: rule.selector, covered: true });
  });

  test("every animation that is not driven by a token is switched off in a reduced-motion block of its own file", () => {
    const sources = [
      ["components", parsed.components],
      ["base", parsed.base],
      ["rating", parsed.rating],
    ];
    for (const [name, file] of sources) {
      const looping = file.rules.filter(
        (r) =>
          r.media !== REDUCE &&
          /^[^n]/.test(r.declarations.animation || "n") &&
          !/^var|none/.test(r.declarations.animation || ""),
      );
      for (const rule of looping) {
        const off = file.rules.some(
          (r) =>
            r.media === REDUCE &&
            r.selector
              .split(",")
              .map((s) => s.trim())
              .includes(rule.selector) &&
            r.declarations.animation === "none",
        );
        expect({ file: name, selector: rule.selector, off }).toEqual({
          file: name,
          selector: rule.selector,
          off: true,
        });
      }
    }
  });

  test("the map script reads the preference and uses it for every move", () => {
    const map = read("public/js/searchMap.js");
    expect(map).toMatch(
      /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/,
    );
    expect(map).toMatch(/MOVE_MS = reducedMotion \? 0/);
  });
});

describe("loading skeletons", () => {
  test("the skeleton blocks and the map's loading background exist and are switched off under reduced motion", () => {
    const skeleton = parsed.components.rules.find(
      (r) => r.selector === ".skeleton" && !r.media,
    );
    expect(skeleton.declarations.animation).toMatch(
      /^skeleton-pulse var\(--duration-loading\)/,
    );
    const off = parsed.components.rules.find(
      (r) => r.media === REDUCE && r.selector.includes(".skeleton"),
    );
    expect(off.selector).toContain("#search-map.is-loading");
    expect(off.declarations.animation).toBe("none");
    expect(
      parsed.components.rules.some(
        (r) => r.selector === ".skeleton-stack .skeleton:nth-child(odd)",
      ),
    ).toBe(true);
  });

  test("the price panel shows a skeleton while it waits, hidden from screen readers, with aria-busy only while waiting", () => {
    const panel = read("public/js/booking-panel.js");
    expect(panel).toMatch(/function showLoading\(\)/);
    expect(panel).toMatch(/stack\.setAttribute\("aria-hidden", "true"\)/);
    expect(panel).toMatch(/result\.setAttribute\("aria-busy", "true"\)/);
    expect(panel).toMatch(
      /function show\(node\) \{\s*result\.removeAttribute\("aria-busy"\)/,
    );
    expect(panel).toMatch(/showLoading\(\);/);
    expect(panel).toContain("Checking the price…"); // the live region still says it in words
  });

  test("the search map marks itself loading, and every way out removes the mark", () => {
    const map = read("public/js/searchMap.js");
    expect(map.match(/classList\.add\("is-loading"\)/g)).toHaveLength(1);
    expect(
      map.match(/classList\.remove\("is-loading"\)/g).length,
    ).toBeGreaterThanOrEqual(3); // success, failure, map unavailable
  });
});

describe("narrow screens", () => {
  test("every breakpoint is one of Bootstrap's, with .98 on the max side (no 1 px gap or overlap)", () => {
    const widths = new Set();
    for (const text of Object.values(css))
      for (const m of text.matchAll(
        /@media[^{]*\((max|min)-width:\s*([0-9.]+px)\)/g,
      ))
        widths.add(`${m[1]} ${m[2]}`);
    const allowed = new Set([
      "max 575.98px",
      "max 767.98px",
      "max 991.98px",
      "max 1199.98px",
      "min 576px",
      "min 768px",
      "min 992px",
      "min 1200px",
    ]);
    expect([...widths].filter((w) => !allowed.has(w))).toEqual([]);
    expect(widths.size).toBeGreaterThan(0);
  });

  test("nothing is a fixed width wider than a 360 px phone unless it scrolls inside its own container", () => {
    // [selector, why it is fine]
    const scrolls = new Map([
      [".cal-grid", "the host calendar table sits in .table-responsive"],
    ]);
    for (const rule of allRules) {
      for (const prop of ["width", "min-width"]) {
        const value = rule.declarations[prop];
        if (!value) continue;
        const px = rem(value);
        if (px === null || px <= 320 || rule.media) continue;
        expect({
          selector: rule.selector,
          prop,
          value,
          allowed: scrolls.has(rule.selector),
        }).toEqual({ selector: rule.selector, prop, value, allowed: true });
      }
    }
    const calendar = read("views/host/calendar.ejs");
    expect(calendar.indexOf("table-responsive")).toBeGreaterThan(-1);
    expect(calendar.indexOf("table-responsive")).toBeLessThan(
      calendar.indexOf("cal-grid"),
    );
  });

  test("100vw is only used inside min(), so the vertical scrollbar cannot push the page sideways", () => {
    for (const rule of allRules)
      for (const [prop, value] of Object.entries(rule.declarations)) {
        if (/100vw/.test(value))
          expect({
            selector: rule.selector,
            prop,
            ok: /min\(\s*100vw/.test(value),
          }).toEqual({ selector: rule.selector, prop, ok: true });
      }
  });

  test("every table is inside a .table-responsive wrapper", () => {
    const walk = (dir) =>
      fs
        .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
        );
    const tables = walk("views").filter(
      (f) => f.endsWith(".ejs") && /<table/.test(read(f)),
    );
    expect(tables.length).toBeGreaterThanOrEqual(8);
    for (const file of tables) {
      const text = read(file);
      const wrapped =
        text.indexOf("table-responsive") > -1 &&
        text.indexOf("table-responsive") < text.indexOf("<table");
      expect({ file, wrapped }).toEqual({ file, wrapped: true });
    }
  });

  test("the page scales: viewport meta without a zoom lock, images never wider than their box", () => {
    const layout = read("views/layouts/boilerPlate.ejs");
    const meta = /<meta name="viewport" content="([^"]*)"/.exec(layout)[1];
    expect(meta).toMatch(/width=device-width/);
    expect(meta).toMatch(/initial-scale=1/);
    expect(meta).not.toMatch(/maximum-scale|user-scalable/i);
    const img = parsed.base.rules.find((r) => r.selector === "img");
    expect(img.declarations["max-width"]).toBe("100%");
  });

  test("text in form controls is at least 16 px, so a phone does not zoom in on focus", () => {
    expect(css.tokens).toMatch(/--font-size-md:\s*1rem/);
    for (const rule of allRules) {
      const size = rule.declarations["font-size"];
      if (
        !size ||
        !/(^|[ ,])(input|select|textarea|\.form-control|\.form-select)\b/.test(
          rule.selector,
        )
      )
        continue;
      const px = rem(size);
      if (px !== null)
        expect({ selector: rule.selector, ok: px >= 16 }).toEqual({
          selector: rule.selector,
          ok: true,
        });
    }
  });
});

describe("the CSS reader itself", () => {
  test("reads rules, nested media queries and keyframes", () => {
    const { rules, keyframes } = parseCss(
      "a{b:1} @media (max-width: 10px){ .x, .y{ c: 2; d: var(--e) } } @keyframes k{0%{opacity:1}} /* c{z:1} */ p{q:r}",
    );
    expect(rules.map((r) => [r.selector, r.media])).toEqual([
      ["a", null],
      [".x, .y", "(max-width: 10px)"],
      ["p", null],
    ]);
    expect(rules[1].declarations).toEqual({ c: "2", d: "var(--e)" });
    expect(keyframes).toEqual(["k"]);
  });
});
