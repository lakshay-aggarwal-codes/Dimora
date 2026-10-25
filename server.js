// Entry point: loads and validates the environment, connects to MongoDB and
// starts listening. The app itself lives in src/app.js (createApp) so tests can
// import it without a database or a port.
require("dotenv").config({ quiet: true });

const { loadEnv, EnvValidationError } = require("./src/config/env");

let config;
try {
  config = loadEnv();
} catch (err) {
  if (err instanceof EnvValidationError) {
    console.error(err.format());
    process.exit(1);
  }
  throw err;
}
config.warnings.forEach((w) => console.warn(`[config] ${w}`));

if (config.dnsServers.length) {
  require("node:dns").setServers(config.dnsServers);
}

const mongoose = require("mongoose");
const { createApp } = require("./src/app");
require("./src/controllers/listing").initGeocoding();

const app = createApp({ config });
const PORT = config.port;

// Housekeeping (P07-T07): started once the database is connected.
function startHousekeeping() {
  if (!config.sweeper.enabled) {
    console.log("Sweeper disabled (SWEEPER_ENABLED=false)");
    return;
  }
  const { createLogger } = require("./src/config/logger");
  const { createSweeper, startSweeper } = require("./src/services/sweeper");
  const logger = createLogger();
  startSweeper({
    runOnce: createSweeper({ logger }).runOnce,
    intervalMs: config.sweeper.intervalMs,
    logger,
  });
}

// Nearby places (P15-T01): fail at start-up on a bad OVERPASS_URL, then retry
// the fetches that failed every few minutes.
function startNearby() {
  const { readNearbyConfig } = require("./src/config/nearby");
  let nearbyConfig;
  try {
    nearbyConfig = readNearbyConfig();
  } catch (err) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  if (!nearbyConfig.enabled) {
    console.log("Nearby places disabled (NEARBY_ENABLED=false)");
    return;
  }
  const { createLogger } = require("./src/config/logger");
  require("./src/services/nearbyRetry").startNearbyRetry({
    logger: createLogger(),
    config: nearbyConfig,
  });
}

async function main() {
  await mongoose.connect(config.mongodbUri);
}

main()
  .then(() => {
    console.log("Connected to DB");
    startHousekeeping();
    startNearby();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });
