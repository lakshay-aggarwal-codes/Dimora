// Graceful shutdown (P19-T03). Hosts stop a service by sending SIGTERM (every
// deploy and every spin-down) and kill it if it has not exited after a grace
// period. This stops the background timers, lets requests that are already
// running finish, closes the database connection, then exits.
//
// Pure of process globals: server.js passes in the real server, signals and
// `process.exit`; tests pass fakes.

/**
 * @param {object} deps
 * @param {{ close: Function, closeIdleConnections?: Function, closeAllConnections?: Function }} deps.server
 * @param {() => Promise<void>} deps.closeDb
 * @param {Array<() => void>} [deps.stoppers]  timers to stop first
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @param {number} [deps.timeoutMs]  after this long, connections are cut and exit code is 1
 * @param {(code: number) => void} [deps.exit]
 * @returns {(signal?: string) => Promise<void>} idempotent: a second call is ignored
 */
function createShutdown({
  server,
  closeDb,
  stoppers = [],
  logger = {},
  timeoutMs = 10_000,
  exit = process.exit,
}) {
  const log = (level, ...args) => {
    if (typeof logger[level] === "function") logger[level](...args);
  };
  let started = false;

  return async function shutdown(signal = "shutdown") {
    if (started) return;
    started = true;
    log("info", `${signal} received: shutting down`);

    let forced = false;
    const force = setTimeout(() => {
      forced = true;
      log("error", `shutdown took longer than ${timeoutMs} ms: closing connections`);
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      exit(1);
    }, timeoutMs);

    for (const stop of stoppers) {
      try {
        stop();
      } catch (err) {
        log("warn", `could not stop a timer: ${err && err.message}`);
      }
    }

    let code = 0;
    try {
      // Stop accepting connections; idle keep-alive sockets would otherwise
      // hold the server open until they time out.
      const closed = new Promise((resolve) => server.close(() => resolve()));
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      await closed;
      await closeDb();
    } catch (err) {
      code = 1;
      log("error", `error during shutdown: ${err && err.message}`);
    }

    clearTimeout(force);
    if (!forced) exit(code);
  };
}

module.exports = { createShutdown };
