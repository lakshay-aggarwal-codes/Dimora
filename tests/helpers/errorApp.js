// A tiny Express app that uses the real error handler and the real error.ejs,
// so tests can make a route throw anything and look at what a visitor sees.
const path = require("node:path");
const express = require("express");
const ejsMate = require("ejs-mate");
const { createErrorHandler } = require("../../src/middleware/errors");
const { createLogger } = require("../../src/config/logger");

const ROOT = path.join(__dirname, "..", "..");

function buildErrorApp({ isProduction, routes, logger }) {
  const log = logger || createLogger({ level: "silent" });
  const app = express();
  app.engine("ejs", ejsMate);
  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT, "views"));
  app.use((req, res, next) => {
    req.id = "test-request-id";
    res.locals.success = [];
    res.locals.error = [];
    res.locals.currUser = undefined;
    res.locals.mapPublicToken = "";
    next();
  });
  routes(app);
  app.use(createErrorHandler({ isProduction, logger: log }));
  return app;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withErrorApp(options, fn) {
  const { base, close } = await listen(buildErrorApp(options));
  try {
    return await fn(base);
  } finally {
    await close();
  }
}

module.exports = { buildErrorApp, listen, withErrorApp };
