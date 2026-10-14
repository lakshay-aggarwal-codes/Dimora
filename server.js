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

async function main() {
  await mongoose.connect(config.mongodbUri);
}

main()
  .then(() => {
    console.log("Connected to DB");

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });
