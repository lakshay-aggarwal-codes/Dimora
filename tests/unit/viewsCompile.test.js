// P18-T03: every template must at least compile, and no EJS comment may contain
// a tag. A comment such as `<%# ... <%= %> ... %>` ends at the first `%>`, the
// rest is read as text and the page fails with "Could not find matching close
// tag": two real pages (the host status page for a published listing and the
// comparison page) were broken this way until this check existed.
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

const VIEWS = path.join(__dirname, "..", "..", "views");
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
const files = walk(VIEWS).filter((f) => f.endsWith(".ejs"));
const rel = (f) => path.relative(VIEWS, f).split(path.sep).join("/");

describe("templates", () => {
  test("there are templates to check", () =>
    expect(files.length).toBeGreaterThan(50));

  test.each(files.map((f) => [rel(f), f]))("%s compiles", (_name, file) => {
    expect(() =>
      ejs.compile(fs.readFileSync(file, "utf8"), { filename: file }),
    ).not.toThrow();
  });

  test.each(files.map((f) => [rel(f), f]))(
    "%s: no comment contains a tag",
    (_name, file) => {
      const text = fs.readFileSync(file, "utf8");
      const bad = [];
      for (let i = text.indexOf("<%#"); i !== -1;) {
        const end = text.indexOf("%>", i);
        if (end === -1) {
          bad.push(text.slice(i, i + 60));
          break;
        }
        if (text.slice(i + 3, end).includes("<%"))
          bad.push(text.slice(i, i + 60));
        i = text.indexOf("<%#", end);
      }
      expect(bad).toEqual([]);
    },
  );
});
