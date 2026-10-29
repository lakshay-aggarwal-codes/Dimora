// Click-through of the Best-match orderings (P15-T06; docs/RANKING.md):
//
//   npm run report:ranking
//
// Reads the counters in ListingStat (database from MONGODB_URI). Counts only.
require("dotenv").config();

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  const mongoose = require("mongoose");
  const ListingStat = require("../src/models/listingStat");
  const { summary } = require("../src/services/rankingStats");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    const rows = await summary({ ListingStat });
    console.log("ordering   shown   clicked   click-through");
    for (const r of rows) {
      const ctr = r.ctr === null ? "n/a" : `${(100 * r.ctr).toFixed(1)}%`;
      console.log(`${r.variant.padEnd(10)} ${String(r.shown).padStart(5)}   ${String(r.clicked).padStart(7)}   ${ctr.padStart(13)}`);
    }
    const base = rows.find((r) => r.variant === "default");
    if (!base || base.shown < 200) console.log("\nToo few impressions in the default order (under 200) to compare anything.");
    else console.log("\nCompare with care: see docs/RANKING.md (position, season, who searched).");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
