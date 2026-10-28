// P19-T01: docs/API.md must say what the app serves. The routes are read from
// the routers (src/utils/routeList.js); the table is read from the markdown.
const fs = require("node:fs");
const path = require("node:path");
const { listRoutes, mounts } = require("../../src/utils/routeList");

const api = fs.readFileSync(
  path.join(__dirname, "..", "..", "docs", "API.md"),
  "utf8",
);

function documented() {
  const rows = [];
  for (const line of api.split("\n")) {
    const m =
      /^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \| ([^|]+) \| (.+) \|$/.exec(
        line,
      );
    if (m)
      rows.push({
        method: m[1],
        path: m[2],
        who: m[3].trim(),
        what: m[4].trim(),
      });
  }
  return rows;
}

const key = (r) => `${r.method} ${r.path}`;

describe("docs/API.md", () => {
  const real = listRoutes();
  const docs = documented();

  test("lists every route the app serves, and no route it does not", () => {
    const have = new Set(real.map(key));
    const said = new Set(docs.map(key));
    expect({ missingFromDocs: [...have].filter((k) => !said.has(k)) }).toEqual({
      missingFromDocs: [],
    });
    expect({ notInApp: [...said].filter((k) => !have.has(k)) }).toEqual({
      notInApp: [],
    });
    expect(docs).toHaveLength(real.length);
    expect(new Set(docs.map(key)).size).toBe(docs.length); // no route listed twice
  });

  test("the number in the README is the number of routes", () => {
    const readme = fs.readFileSync(
      path.join(__dirname, "..", "..", "README.md"),
      "utf8",
    );
    expect(readme).toContain(`full list of the ${real.length} routes`);
  });

  test("'who' agrees with the guard the code enforces", () => {
    for (const r of real) {
      const said = docs.find((d) => key(d) === key(r)).who;
      const expected = r.guards.includes("adminGuard")
        ? /^admin/
        : r.guards.includes("isLoggedIn")
          ? /^signed in/
          : /^anyone$/;
      expect({ route: key(r), who: said, ok: expected.test(said) }).toEqual({
        route: key(r),
        who: said,
        ok: true,
      });
    }
  });

  test("every route has a sentence, and every admin route is under /admin", () => {
    for (const d of docs) expect(d.what.length).toBeGreaterThan(8);
    for (const d of docs)
      if (d.who.startsWith("admin"))
        expect(d.path.startsWith("/admin")).toBe(true);
    expect(
      real
        .filter((r) => r.path.startsWith("/admin"))
        .every((r) => r.guards.includes("adminGuard")),
    ).toBe(true);
  });

  test("the routes the table calls JSON are the ones under /api, and only those", () => {
    const section = api.slice(api.indexOf("## The JSON routes"));
    const jsonRoutes = [...section.matchAll(/^\| `GET (\/api\/[^`]+)`/gm)]
      .map((m) => m[1])
      .sort();
    expect(jsonRoutes).toEqual(
      real
        .filter((r) => r.path.startsWith("/api/"))
        .map((r) => r.path)
        .sort(),
    );
  });

  test("the route reader finds every mounted router and rejects nothing it cannot read", () => {
    const m = mounts();
    expect(m.length).toBeGreaterThanOrEqual(10);
    const files = fs
      .readdirSync(path.join(__dirname, "..", "..", "src", "routes"))
      .map((f) => f.replace(/\.js$/, ""));
    // every router file in src/routes is mounted (a router nobody mounts would be a dead page)
    expect(files.filter((f) => !m.some((x) => x.file === f))).toEqual([]);
  });

  test("the guard reader sees a chained route per method (a public GET next to a private POST)", () => {
    const get = real.find((r) => r.method === "GET" && r.path === "/listings");
    const post = real.find(
      (r) => r.method === "POST" && r.path === "/listings",
    );
    expect(get.guards).toEqual([]);
    expect(post.guards).toEqual(["isLoggedIn"]);
  });
});
