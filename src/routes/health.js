// Health endpoints (P19-T03).
//
//   GET /healthz   liveness: the process is up and answering. Never touches
//                  the database, so a slow or paused database cannot make the
//                  host restart a healthy server. This is the host's check.
//   GET /readyz    readiness: 200 only while the MongoDB connection is open,
//                  503 otherwise. For uptime monitors and the smoke script.
//
// Both answer GET and HEAD with a tiny JSON body, `Cache-Control: no-store`,
// and nothing about the build, versions, hosts or settings.
const express = require("express");

/** True while the default Mongoose connection is connected (readyState 1). */
function mongooseIsReady() {
  // Required here, not at the top: requiring this file must not load Mongoose.
  return require("mongoose").connection.readyState === 1;
}

/**
 * @param {object} [options]
 * @param {() => (boolean|Promise<boolean>)} [options.isDbReady]
 * @returns {import("express").Router}
 */
function createHealthRouter({ isDbReady = mongooseIsReady } = {}) {
  const router = express.Router();

  router.all(["/healthz", "/readyz"], (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD");
      return res.status(405).json({ status: "method not allowed" });
    }
    res.set("Cache-Control", "no-store");
    return next();
  });

  router.get("/healthz", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/readyz", async (req, res) => {
    let ready = false;
    try {
      ready = Boolean(await isDbReady());
    } catch {
      ready = false;
    }
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? "ready" : "unavailable" });
  });

  return router;
}

module.exports = { createHealthRouter, mongooseIsReady };
