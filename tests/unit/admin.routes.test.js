// P14-T01: the admin route table is checked without calling anything.
//  - every route is behind adminGuard;
//  - every route that changes data is wrapped in auditedMutation, so "a
//    mutation without an audit entry" cannot be added by accident;
//  - there is no route that edits or deletes an audit row.
const router = require("../../src/routes/admin");
const { adminGuard } = require("../../src/middleware/admin");

const SAFE = new Set(["get", "head", "options"]);

function routes() {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods),
      handlers: layer.route.stack.map((l) => l.handle),
    }));
}

test("adminGuard is the first thing every request meets", () => {
  expect(router.stack[0].handle).toBe(adminGuard);
});

test("the area has the landing page and the audit viewer", () => {
  const paths = routes().map((r) => r.path);
  expect(paths).toEqual(expect.arrayContaining(["/", "/audit"]));
});

test("every route that is not a read is wrapped in auditedMutation", () => {
  const unsafe = routes().filter((r) => r.methods.some((m) => !SAFE.has(m)));
  for (const route of unsafe) {
    const wrapped = route.handlers.some((h) => h.auditedMutation === true);
    if (!wrapped) {
      throw new Error(`${route.methods.join(",").toUpperCase()} /admin${route.path} changes data but is not wrapped in auditedMutation`);
    }
  }
});

test("no route changes or removes audit entries", () => {
  const bad = routes().filter(
    (r) => r.path.startsWith("/audit") && r.methods.some((m) => !SAFE.has(m)),
  );
  expect(bad).toEqual([]);
});

test("the check itself notices an unwrapped data-changing route", () => {
  const express = require("express");
  const probe = express.Router();
  probe.post("/users/:id/suspend", (req, res) => res.end());
  const layer = probe.stack.find((l) => l.route);
  const wrapped = layer.route.stack.some((l) => l.handle.auditedMutation === true);
  expect(wrapped).toBe(false);
});
