// In-memory MongoDB for integration tests (mongodb-memory-server).
// The first run downloads a mongod binary (a few hundred MB, cached afterwards).
//
//   const { describeDb, useTestDb } = require("../helpers/db");
//   describeDb("my suite", () => {
//     useTestDb();           // connect once, wipe collections after each test
//     test(...)
//   });
//
// With SKIP_DB_TESTS=1 describeDb skips the whole suite (no mongod needed).
// With TEST_MONGODB_URI=mongodb://host:port set, tests use that server (a fresh
// database per test file, dropped afterwards) instead of downloading mongod.
const mongoose = require("mongoose");

const HOOK_TIMEOUT_MS = 180000; // first run downloads the binary

const describeDb = process.env.SKIP_DB_TESTS === "1" ? describe.skip : describe;

const EXTERNAL_URI = process.env.TEST_MONGODB_URI;

let mongod;

async function connectTestDb() {
  if (EXTERNAL_URI) {
    const dbName = `dimora_test_${process.pid}_${Date.now()}`;
    await mongoose.connect(EXTERNAL_URI, { dbName });
  } else {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: "dimora_test" });
  }
  // Build indexes up front so unique-index behaviour is the same as production.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}

async function clearTestDb() {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({})),
  );
}

async function disconnectTestDb() {
  if (EXTERNAL_URI && mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  mongod = undefined;
}

/** Registers the hooks that connect, clean and disconnect the test database. */
function useTestDb() {
  beforeAll(connectTestDb, HOOK_TIMEOUT_MS);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb, HOOK_TIMEOUT_MS);
}

module.exports = {
  describeDb,
  useTestDb,
  connectTestDb,
  clearTestDb,
  disconnectTestDb,
};
