// Imports listings from the public "sample_airbnb" dataset into a DEVELOPMENT
// database, owned by the demo host (same account as `npm run seed`).
//
//   npm run import:airbnb -- --file C:\data\listingsAndReviews.json --limit 300 --dry-run
//   npm run import:airbnb -- --file C:\data\listingsAndReviews.json --limit 300
//
// Options: --file <path> (required), --limit <n> (default 300), --usd-inr <rate>
// (default 85, approximate), --dry-run (map and validate, no database needed, write nothing).
// Idempotent: a listing is matched by (owner, importedFrom.id). Refuses to run
// when NODE_ENV=production. The file is read line by line, never loaded whole.
const fs = require("node:fs");
const readline = require("node:readline");
const mongoose = require("mongoose");
const Listing = require("../src/models/listing.js");
const { ensureDemoHost, assertSeedAllowed, resolveMongoUri, SeedError } = require("./seed.js");
const { mapListing } = require("./lib/airbnb-sample.js");

function parseArgs(argv) {
  const opts = { file: "", limit: 300, usdInr: 85, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--file") opts.file = argv[++i] || "";
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg === "--usd-inr") opts.usdInr = Number(argv[++i]);
    else throw new SeedError(`Unknown argument: ${arg}`);
  }
  if (!opts.file) throw new SeedError("--file <path to listingsAndReviews.json> is required.");
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 5555) {
    throw new SeedError("--limit must be a whole number from 1 to 5555.");
  }
  if (!(opts.usdInr >= 1 && opts.usdInr <= 1000)) {
    throw new SeedError("--usd-inr must be a number from 1 to 1000.");
  }
  return opts;
}

/** Reads up to `limit` importable listings; counts why the others were skipped. */
async function readListings(file, { limit, usdInr, ownerId }) {
  const docs = [];
  const skipped = {};
  let lines = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8") });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    let source;
    try {
      source = JSON.parse(line);
    } catch {
      skipped["bad json"] = (skipped["bad json"] || 0) + 1;
      continue;
    }
    const result = mapListing(source, { ownerId, usdToInr: usdInr });
    if (result.skipped) {
      skipped[result.skipped] = (skipped[result.skipped] || 0) + 1;
      continue;
    }
    try {
      await new Listing(result.doc).validate();
    } catch {
      skipped["invalid"] = (skipped["invalid"] || 0) + 1;
      continue;
    }
    docs.push(result.doc);
    if (docs.length >= limit) {
      rl.close();
      break;
    }
  }
  return { docs, skipped, lines };
}

async function main(argv = process.argv.slice(2)) {
  require("dotenv").config({ quiet: true });
  assertSeedAllowed();
  const opts = parseArgs(argv);

  // A dry run needs no database: it only maps and validates the file.
  if (opts.dryRun) {
    const ownerId = new mongoose.Types.ObjectId();
    const { docs, skipped, lines } = await readListings(opts.file, { ...opts, ownerId });
    console.log(`Read ${lines} lines, ${docs.length} importable (rate ${opts.usdInr} INR per USD).`);
    if (Object.keys(skipped).length) console.log("Skipped:", skipped);
    return console.log("Dry run: nothing written.");
  }

  // Same DNS override as migrate.js: Atlas "mongodb+srv" lookups fail on some
  // networks unless DNS_SERVERS (for example 8.8.8.8,1.1.1.1) is set.
  const dnsServers = (process.env.DNS_SERVERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (dnsServers.length) require("node:dns").setServers(dnsServers);

  await mongoose.connect(resolveMongoUri());
  try {
    const { user: owner } = await ensureDemoHost();
    const { docs, skipped, lines } = await readListings(opts.file, { ...opts, ownerId: owner._id });
    console.log(`Read ${lines} lines, ${docs.length} importable (rate ${opts.usdInr} INR per USD).`);
    if (Object.keys(skipped).length) console.log("Skipped:", skipped);

    const result = await Listing.bulkWrite(
      docs.map((doc) => ({
        updateOne: {
          filter: { owner: owner._id, "importedFrom.id": doc.importedFrom.id },
          update: { $set: doc },
          upsert: true,
        },
      })),
    );
    // bulkWrite skips the validate hook: save once so the public point is set.
    const needPoint = await Listing.find({ owner: owner._id, publicGeometry: { $exists: false } });
    for (const doc of needPoint) await doc.save();
    console.log(`Created ${result.upsertedCount}, updated ${result.matchedCount}.`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof SeedError ? `Import failed: ${err.message}` : err);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, readListings };
