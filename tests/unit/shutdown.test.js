// P19-T03: graceful shutdown.
const assert = require("node:assert/strict");
const { createShutdown } = require("../../src/config/shutdown");

function fakeServer({ closeCallsBack = true } = {}) {
  const calls = [];
  return {
    calls,
    close(cb) {
      calls.push("close");
      if (closeCallsBack) setImmediate(cb);
    },
    closeIdleConnections() {
      calls.push("closeIdle");
    },
    closeAllConnections() {
      calls.push("closeAll");
    },
  };
}

test("stops timers, closes the server, then the database, then exits 0", async () => {
  const order = [];
  const server = fakeServer();
  const exits = [];
  const shutdown = createShutdown({
    server,
    stoppers: [() => order.push("timer1"), () => order.push("timer2")],
    closeDb: async () => order.push("db"),
    exit: (c) => exits.push(c),
    timeoutMs: 1000,
  });
  await shutdown("SIGTERM");
  assert.deepEqual(order, ["timer1", "timer2", "db"]);
  assert.deepEqual(server.calls, ["close", "closeIdle"]);
  assert.deepEqual(exits, [0]);
});

test("a second signal is ignored", async () => {
  let dbCloses = 0;
  const exits = [];
  const shutdown = createShutdown({
    server: fakeServer(),
    closeDb: async () => (dbCloses += 1),
    exit: (c) => exits.push(c),
    timeoutMs: 1000,
  });
  await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
  await shutdown("SIGTERM");
  assert.equal(dbCloses, 1);
  assert.deepEqual(exits, [0]);
});

test("a timer that throws does not stop the shutdown", async () => {
  const logs = [];
  const exits = [];
  const shutdown = createShutdown({
    server: fakeServer(),
    stoppers: [
      () => {
        throw new Error("boom");
      },
    ],
    closeDb: async () => {},
    logger: { warn: (m) => logs.push(m), info() {}, error() {} },
    exit: (c) => exits.push(c),
    timeoutMs: 1000,
  });
  await shutdown();
  assert.deepEqual(exits, [0]);
  assert.ok(logs.some((m) => m.includes("boom")));
});

test("a database that fails to close gives exit code 1", async () => {
  const exits = [];
  const shutdown = createShutdown({
    server: fakeServer(),
    closeDb: async () => {
      throw new Error("db close failed");
    },
    exit: (c) => exits.push(c),
    timeoutMs: 1000,
  });
  await shutdown();
  assert.deepEqual(exits, [1]);
});

test("requests that never finish are cut after the timeout and the exit code is 1", async () => {
  const server = fakeServer({ closeCallsBack: false });
  const exits = [];
  const shutdown = createShutdown({
    server,
    closeDb: async () => {},
    exit: (c) => exits.push(c),
    timeoutMs: 20,
  });
  // The server never calls back, so this promise would hang: the timer rescues it.
  shutdown();
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(server.calls.includes("closeAll"));
  assert.deepEqual(exits, [1]);
});

test("works with a server that has no closeIdleConnections", async () => {
  const server = { close: (cb) => setImmediate(cb) };
  const exits = [];
  await createShutdown({
    server,
    closeDb: async () => {},
    exit: (c) => exits.push(c),
    timeoutMs: 1000,
  })();
  assert.deepEqual(exits, [0]);
});
