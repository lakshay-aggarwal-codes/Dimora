// Fingerprint of a database, and comparison of two (P17-T05; docs/RECOVERY.md).
//
//   npm run data:snapshot -- --out before.json     (database from MONGODB_URI)
//   npm run data:compare -- before.json after.json
//
// Reads counts and index names only. The connection string is read from the
// environment (or .env), never from the command line, so it stays out of your
// shell history.
require("dotenv").config();
const fs = require("node:fs");
const { buildSnapshot, compareSnapshots } = require("./lib/dataSnapshot");

async function main(argv) {
  if (argv[0] === "--compare") {
    const [a, b] = [argv[1], argv[2]].map((f) => {
      if (!f) throw new Error("Usage: npm run data:compare -- before.json after.json");
      return JSON.parse(fs.readFileSync(f, "utf8"));
    });
    const { same, differences, notes } = compareSnapshots(a, b);
    for (const n of notes) console.log(`note  ${n}`);
    for (const d of differences) console.log(`DIFF  ${d}`);
    console.log(same ? "The two snapshots match (apart from the notes)." : "The snapshots DIFFER.");
    return same ? 0 : 1;
  }
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : null;
  if (!out) throw new Error("Usage: npm run data:snapshot -- --out before.json");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  const mongoose = require("mongoose");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    const snap = await buildSnapshot(mongoose.connection.db);
    fs.writeFileSync(out, JSON.stringify(snap, null, 2));
    const total = Object.values(snap.collections).reduce((n, c) => n + c.count, 0);
    console.log(`Wrote ${out}: ${Object.keys(snap.collections).length} collections, ${total} documents, ${snap.migrations.length} migrations.`);
  } finally {
    await mongoose.disconnect();
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(2);
    },
  );
}

module.exports = { main };
