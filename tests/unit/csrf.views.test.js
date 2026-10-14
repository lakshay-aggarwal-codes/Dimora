// P01-T10: every POST form in the views must carry the CSRF token, either as
// the hidden-field partial or (multipart forms) as `_csrf` in the action URL.
// Static check, no rendering: a new form without a token fails here.
const fs = require("node:fs");
const path = require("node:path");

const VIEWS = path.join(__dirname, "..", "..", "views");

function ejsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ejsFiles(full);
    return entry.name.endsWith(".ejs") ? [full] : [];
  });
}

const forms = [];
for (const file of ejsFiles(VIEWS)) {
  const source = fs.readFileSync(file, "utf8");
  const re = /<form\b[\s\S]*?<\/form>/gi;
  let match;
  while ((match = re.exec(source))) {
    const html = match[0];
    // The opening tag may contain `<%= ... %>`, whose `>` must not end it.
    const open = html.match(/<form\b(?:<%[\s\S]*?%>|[^>])*>/i)[0];
    if (/method\s*=\s*["']?post/i.test(open)) {
      forms.push({
        file: path.relative(VIEWS, file).replace(/\\/g, "/"),
        open,
        html,
      });
    }
  }
}

test("the views contain POST forms (the check is looking at something)", () => {
  expect(forms.length).toBeGreaterThanOrEqual(8);
});

test.each(
  forms.map((f) => [f.file, f.open.replace(/\s+/g, " ").slice(0, 90), f]),
)("%s: %s carries a CSRF token", (file, openTag, form) => {
  const hasHidden = /include\(\s*["'][^"']*csrf\.ejs["']\s*\)/.test(form.html);
  const hasQuery = /action\s*=\s*"[^"]*[?&]_csrf=/.test(form.open);
  expect(hasHidden || hasQuery).toBe(true);
});

test("multipart forms use the query string, not a body field", () => {
  for (const form of forms.filter((f) =>
    /multipart\/form-data/i.test(f.open),
  )) {
    expect(form.open).toMatch(/[?&]_csrf=/);
    expect(form.html).not.toMatch(/csrf\.ejs/);
  }
});

test("no view reads `locals.` (under ejs-mate it is not the render data)", () => {
  for (const file of ejsFiles(VIEWS)) {
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/\blocals\.[A-Za-z_]/);
  }
});
