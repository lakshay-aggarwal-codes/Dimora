// P03-T04: responsive and accessibility rules for the page views, checked on
// the source (no rendering, no browser, no database). A view that goes back to
// fixed `col-6 offset-3` columns, loses its <h1> or gets an unlabelled control
// fails here.
const fs = require("node:fs");
const path = require("node:path");

const VIEWS = path.join(__dirname, "..", "..", "views");
const PAGE_DIRS = ["listings", "users", "pages"];
const rel = (file) => path.relative(VIEWS, file).replace(/\\/g, "/");

function ejsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ejsFiles(full);
    return entry.name.endsWith(".ejs") ? [full] : [];
  });
}

const allViews = ejsFiles(VIEWS);
const pageViews = [
  path.join(VIEWS, "error.ejs"),
  ...PAGE_DIRS.flatMap((d) => ejsFiles(path.join(VIEWS, d))),
];
const read = (file) => fs.readFileSync(file, "utf8");
const count = (text, re) => (text.match(re) || []).length;
// An opening tag; its attributes may contain <%= ... %>, whose `>` must not end it.
const openTag = (name) =>
  new RegExp(`<${name}\\b(?:<%[\\s\\S]*?%>|[^>])*>`, "g");

describe("page layouts are responsive", () => {
  test.each(pageViews.map((f) => [rel(f), f]))(
    "%s has no fixed-width columns or offsets",
    (name, file) => {
      const source = read(file);
      // offset-3, offset-md-2 ... (centre with `mx-auto` instead)
      expect(source).not.toMatch(/\boffset-(?:[a-z]+-)?\d/);
      // col-6, col-8 ... without a breakpoint (col-12 is full width: allowed)
      expect(source).not.toMatch(/\bcol-(?:[1-9]|1[01])\b/);
    },
  );

  test("the listings grid is one column on phones", () => {
    const index = read(path.join(VIEWS, "listings", "index.ejs"));
    expect(index).toMatch(/row-cols-1\b/);
    expect(index).toMatch(/row-cols-md-2\b/);
    expect(index).toMatch(/row-cols-lg-3\b/);
    expect(index).not.toMatch(/row-cols-sm-1/);
  });

  test("the detail page is two columns from lg and stacked below", () => {
    const show = read(path.join(VIEWS, "listings", "show.ejs"));
    expect(show).toMatch(/col-12 col-lg-7/);
    expect(show).toMatch(/col-12 col-lg-5/);
  });

  test("no page view uses inline style attributes or <br> for spacing", () => {
    for (const file of pageViews) {
      const source = read(file);
      expect({ file: rel(file), style: count(source, /\sstyle="/g) }).toEqual({
        file: rel(file),
        style: 0,
      });
      expect({ file: rel(file), br: count(source, /<br\s*\/?>/gi) }).toEqual({
        file: rel(file),
        br: 0,
      });
    }
  });
});

describe("headings", () => {
  test.each(pageViews.map((f) => [rel(f), f]))(
    "%s has exactly one <h1>",
    (name, file) => {
      expect(count(read(file), /<h1[\s>]/g)).toBe(1);
    },
  );
});

describe("forms and images are labelled", () => {
  test.each(pageViews.map((f) => [rel(f), f]))(
    "%s: every label points at an element that exists",
    (name, file) => {
      const source = read(file);
      const ids = new Set(
        [...source.matchAll(/\sid="([^"<%]+)"/g)].map((m) => m[1]),
      );
      for (const [, target] of source.matchAll(
        /<label\b[^>]*\sfor="([^"]+)"/g,
      )) {
        expect({ file: name, for: target, exists: ids.has(target) }).toEqual({
          file: name,
          for: target,
          exists: true,
        });
      }
    },
  );

  test.each(pageViews.map((f) => [rel(f), f]))(
    "%s: every written-out form control has an id (so its label works)",
    (name, file) => {
      const source = read(file);
      for (const [tag] of source.matchAll(
        openTag("(?:input|textarea|select)"),
      )) {
        if (/type="hidden"/.test(tag)) continue;
        expect({
          file: name,
          tag: tag.slice(0, 60),
          hasId: /\sid="/.test(tag),
        }).toEqual({
          file: name,
          tag: tag.slice(0, 60),
          hasId: true,
        });
      }
    },
  );

  test("every <img> in the views has an alt attribute", () => {
    for (const file of allViews) {
      for (const [tag] of read(file).matchAll(openTag("img"))) {
        expect({
          file: rel(file),
          tag: tag.slice(0, 50),
          alt: /\salt=/.test(tag),
        }).toEqual({
          file: rel(file),
          tag: tag.slice(0, 50),
          alt: true,
        });
      }
    }
  });

  test("login and signup use the form-field partial with a message for failed checks", () => {
    for (const name of ["login", "signup"]) {
      const source = read(path.join(VIEWS, "users", `${name}.ejs`));
      expect(source).toMatch(/partials\/form-field\.ejs/);
      expect(count(source, /feedback:/g)).toBeGreaterThanOrEqual(2);
    }
  });

  test("the star rating is a fieldset with a legend (one shared partial, P12-T02)", () => {
    const partial = read(path.join(VIEWS, "partials", "review-form.ejs"));
    expect(partial).toMatch(
      /<fieldset class="starability-slot"[^\n]*>\s*<legend/,
    );
    for (const page of [
      ["listings", "show.ejs"],
      ["trips", "show.ejs"],
    ]) {
      expect(read(path.join(VIEWS, ...page))).toMatch(
        /partials\/review-form\.ejs/,
      );
    }
  });
});

describe("category strip", () => {
  const index = read(path.join(VIEWS, "listings", "index.ejs"));

  test("categories are links inside a labelled nav, not clickable divs", () => {
    expect(index).toMatch(/<nav class="filter-nav" aria-label="Categories">/);
    expect(index).toMatch(
      /<a class="filter<%= category\.active[^>]*href="<%= category\.href %>"/,
    );
    expect(index).not.toMatch(/<div class="filter"/);
  });

  test("category icons are hidden from screen readers", () => {
    expect(index).toMatch(/fa-solid <%= category\.icon %>" aria-hidden="true"/);
    expect(index).toMatch(/fa-chevron-left" aria-hidden="true"/);
    expect(index).toMatch(/fa-chevron-right" aria-hidden="true"/);
  });
});

describe("stylesheets", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "css", "components.css"),
    "utf8",
  );
  const base = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "css", "base.css"),
    "utf8",
  );

  test("the detail photo scales with its column instead of a viewport height", () => {
    const rule = css.match(/\.show-img\s*{[^}]*}/)[0];
    expect(rule).toMatch(/aspect-ratio/);
    expect(rule).not.toMatch(/\bvh\b/);
  });

  test("the map is fluid", () => {
    const rule = base.match(/#map\s*{[^}]*}/)[0];
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).not.toMatch(/\bvw\b|\bvh\b/);
  });

  test("the category links keep a visible keyboard focus", () => {
    expect(css).toMatch(/\.filter:focus-visible/);
  });
});
