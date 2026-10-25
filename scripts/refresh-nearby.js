// Fetches nearby places (P15-T01) for published listings that have none yet,
// one listing after another (7 Overpass queries each), for example the seed
// data:
//
//   npm run nearby:refresh -- --limit 10
//   npm run nearby:refresh -- --limit 10 --all     (also listings fetched before)
//
// Respects the same rules as the app: no listing is fetched twice within 5
// minutes, and fresh data (under 7 days) is left alone unless --all. Needs
// internet and MONGODB_URI; set NEARBY_CONTACT in .env first (it goes into the
// User-Agent). Refuses to run when NODE_ENV=production.
const mongoose = require("mongoose");

function parseArgs(argv) {
  const opts = { limit: 10, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--all") opts.all = true;
    else if (argv[i] === "--limit") opts.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200) {
    throw new Error("--limit must be a whole number from 1 to 200.");
  }
  return opts;
}

async function main(argv = process.argv.slice(2)) {
  require("dotenv").config({ quiet: true });
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run with NODE_ENV=production.");
  }
  const opts = parseArgs(argv);
  const uri = (process.env.MONGODB_URI || process.env.ATLASDB_URL || "").trim();
  if (!uri) throw new Error("MONGODB_URI is not set. Set it in .env first.");
  const dnsServers = (process.env.DNS_SERVERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (dnsServers.length) require("node:dns").setServers(dnsServers);

  const { readNearbyConfig } = require("../src/config/nearby");
  const config = readNearbyConfig();
  if (!config.enabled) throw new Error("NEARBY_ENABLED is false.");
  if (!config.contact) {
    console.warn("Warning: NEARBY_CONTACT is empty; Overpass operators cannot reach you if there is a problem.");
  }

  await mongoose.connect(uri);
  try {
    const Listing = require("../src/models/listing");
    const { refreshListing } = require("../src/services/nearby");
    const filter = { status: "published", deletedAt: null };
    if (!opts.all) filter["nearby.fetchedAt"] = { $exists: false };
    const listings = await Listing.find(filter).limit(opts.limit).lean();
    console.log(`${listings.length} listing(s) to fetch.`);
    const counts = {};
    for (const listing of listings) {
      const result = await refreshListing(listing, { manual: false, deps: { config } });
      counts[result.status] = (counts[result.status] || 0) + 1;
      console.log(`${String(listing._id)}: ${result.status}${result.count !== undefined ? ` (${result.count} places)` : ""}`);
    }
    console.log("Summary:", counts);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`nearby refresh failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs };
