// Runs MongoDB's explain("executionStats") for every hot query of the app
// (src/services/queryPlans.js) on the database in MONGODB_URI and prints what
// each one does: which index, whether it sorts in memory, how many index keys
// and documents it reads. Read-only: it only explains, it never changes data.
//
//   npm run explain                 table to the terminal
//   npm run explain -- --markdown   the same as a Markdown table (for docs/PERFORMANCE.md)
//   npm run explain -- --json       machine-readable
//
// Exit code 1 when a query breaks what it promises (collection scan, in-memory
// sort where none is promised, a document read where the answer should come
// from the index alone). Run it on a database with realistic data: on an empty
// one MongoDB still picks the same indexes, but the numbers say nothing.
// Reads MONGODB_URI (the old ATLASDB_URL is accepted); never prints it.
const mongoose = require("mongoose");

function resolveMongoUri(env = process.env) {
  const uri = (env.MONGODB_URI || env.ATLASDB_URL || "").trim();
  if (!uri)
    throw new Error(
      "MONGODB_URI is not set. Set it in .env (or the shell) first.",
    );
  return uri;
}

const pad = (text, width) => String(text).padEnd(width);

function plain(rows) {
  const lines = [
    `${pad("query", 34)}${pad("plan", 34)}${pad("keys", 7)}${pad("docs", 7)}${pad("ret", 6)}${pad("ms", 5)}check`,
  ];
  for (const r of rows) {
    const plan = r.error
      ? "ERROR"
      : `${r.measured.indexes.join("+") || r.measured.stages[0]}${r.measured.sortInMemory ? " +SORT" : ""}${r.measured.collscan ? " COLLSCAN" : ""}`;
    const m = r.measured || {};
    lines.push(
      `${pad(r.id, 34)}${pad(plan, 34)}${pad(m.keysExamined ?? "-", 7)}${pad(m.docsExamined ?? "-", 7)}${pad(m.returned ?? "-", 6)}${pad(m.millis ?? "-", 5)}${r.error ? r.error : r.problems.length ? `FAIL: ${r.problems.join(", ")}` : "ok"}`,
    );
  }
  return lines.join("\n");
}

function markdown(rows) {
  const lines = [
    "| Query | Plan | Keys | Docs | Returned | ms | Check |",
    "|---|---|---:|---:|---:|---:|---|",
  ];
  for (const r of rows) {
    const m = r.measured || {};
    const plan = r.error
      ? "error"
      : `${m.indexes.join(" + ") || m.stages[0]}${m.sortInMemory ? " + SORT" : ""}${m.collscan ? " COLLSCAN" : ""}`;
    lines.push(
      `| \`${r.id}\` | ${plan} | ${m.keysExamined ?? ""} | ${m.docsExamined ?? ""} | ${m.returned ?? ""} | ${m.millis ?? ""} | ${r.error ? r.error : r.problems.length ? `FAIL: ${r.problems.join(", ")}` : "ok"} |`,
    );
  }
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2)) {
  require("dotenv").config({ quiet: true });
  const {
    hotQueries,
    runExplain,
    violations,
  } = require("../src/services/queryPlans");
  await mongoose.connect(resolveMongoUri());
  try {
    const rows = [];
    for (const query of hotQueries()) {
      try {
        const measured = await runExplain(query);
        rows.push({
          id: query.id,
          measured,
          problems: violations(query, measured),
        });
      } catch (err) {
        rows.push({
          id: query.id,
          error: `explain failed: ${err.message}`,
          problems: ["explain failed"],
        });
      }
    }
    if (argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else
      console.log(argv.includes("--markdown") ? markdown(rows) : plain(rows));
    const failed = rows.filter((r) => r.problems.length);
    if (failed.length) {
      console.error(
        `\n${failed.length} of ${rows.length} queries break what they promise.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`explain failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { resolveMongoUri, plain, markdown, main };
