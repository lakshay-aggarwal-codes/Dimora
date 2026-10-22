// Runs the housekeeping pass once (P07-T07) and prints what it did.
//
//   npm run sweep
//
// The same pass runs inside the server every minute (src/services/sweeper.js);
// this is for checking it by hand or running it from a scheduler. It also runs
// the draft clean-up, which the server does at most once an hour. Reads
// MONGODB_URI from the environment / .env (the old ATLASDB_URL is accepted) and
// never prints the connection string. Exit code 1 if a step failed.
const mongoose = require("mongoose");

function resolveMongoUri(env = process.env) {
  const uri = (env.MONGODB_URI || env.ATLASDB_URL || "").trim();
  if (!uri)
    throw new Error(
      "MONGODB_URI is not set. Set it in .env (or the shell) first.",
    );
  return uri;
}

async function main() {
  require("dotenv").config({ quiet: true });
  await mongoose.connect(resolveMongoUri());
  try {
    const { createSweeper } = require("../src/services/sweeper");
    const summary = await createSweeper().runOnce({ drafts: true });
    console.log(
      `Expired requests: ${summary.expired}\n` +
        `Completed stays: ${summary.completed}\n` +
        `Orphan ledger rows removed: ${summary.orphanNights}\n` +
        `Stale drafts deleted: ${summary.staleDrafts}\n` +
        `Skipped (changed by someone else meanwhile): ${summary.skipped}`,
    );
    for (const problem of summary.errors) {
      console.error(
        `Problem in step "${problem.step}"${problem.id ? ` (${problem.id})` : ""}: ${problem.message}`,
      );
    }
    if (summary.errors.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`sweep failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { resolveMongoUri, main };
