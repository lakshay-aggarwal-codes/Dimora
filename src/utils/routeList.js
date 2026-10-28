// The app's routes as data, read from the routers themselves (P19-T01), so the
// API list in docs/API.md can be checked against what the app really serves
// (tests/unit/docsApi.test.js) instead of being trusted.
//
// Mount points come from src/app.js (`app.use("<prefix>", xRouter)`); the
// routes come from each router's own stack. Handlers wrapped by wrapAsync have
// no name, so "who may call it" is read from the named middleware in front
// (isLoggedIn, adminGuard) and, for the admin and API routers, from the guard
// mounted on the whole router.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const GUARDS = /^(isLoggedIn|adminGuard|isAdmin|requireLogin)$/;

function mounts() {
  const source = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const files = {};
  for (const m of source.matchAll(
    /const (\w+Router) = require\("\.\/routes\/([\w.-]+)"\)/g,
  ))
    files[m[1]] = m[2];
  const found = [];
  for (const m of source.matchAll(/app\.use\("([^"]+)",\s*(\w+Router)\)/g)) {
    if (files[m[2]]) found.push({ prefix: m[1], file: files[m[2]] });
  }
  return found;
}

const join = (prefix, route) => {
  const p =
    `${prefix === "/" ? "" : prefix}${route === "/" ? "" : route}` || "/";
  return p.replace(/\/+$/, "") || "/";
};

/** @returns {Array<{ method: string, path: string, guards: string[], file: string }>} */
function listRoutes() {
  const out = [];
  for (const { prefix, file } of mounts()) {
    const router = require(path.join(ROOT, "src", "routes", file));
    const wide = router.stack
      .filter(
        (l) =>
          !l.route && l.handle && l.handle.name && l.handle.name !== "router",
      )
      .map((l) => l.handle.name);
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        // only the handlers that answer THIS method (a route can chain .get().post())
        const own = layer.route.stack.filter(
          (l) => !l.method || l.method === method,
        );
        const guards = [
          ...new Set([
            ...wide,
            ...own.map((l) => l.handle.name).filter((n) => GUARDS.test(n)),
          ]),
        ];
        out.push({
          method: method.toUpperCase(),
          path: join(prefix, layer.route.path),
          guards,
          file,
        });
      }
    }
  }
  return out.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

module.exports = { listRoutes, mounts };
