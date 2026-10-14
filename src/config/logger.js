const pino = require("pino");

// Anything matching these paths is replaced with "[Redacted]" before it is
// written. Request logs do not include headers or bodies at all (see
// requestSerializer in src/app.js); this list protects values that end up in a
// log call some other way (an error object, a user document, a body).
const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
  "req.body.password",
  "password",
  "hash",
  "salt",
  "*.password",
  "*.hash",
  "*.salt",
  "err.keyValue",
  "err.config",
];

/**
 * @param {object} [options]
 * @param {string} [options.level]  pino level (default "info"; "silent" in tests)
 * @param {import("node:stream").Writable} [options.destination] defaults to stdout
 */
function createLogger({ level = "info", destination } = {}) {
  return pino(
    {
      level,
      base: undefined, // no pid/hostname on every line
      redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
    },
    destination,
  );
}

module.exports = { createLogger, REDACT_PATHS };
