// Database migration runner (P01-T11).
//
//   npm run migrate            apply every pending migration, in order
//   npm run migrate:dry        show what would be applied; writes nothing
//   (same as: npm run migrate -- --dry-run. Without the "--" npm swallows the
//   flag itself, which is why migrate:dry exists.)
//
// Migrations live in scripts/migrations/NNN-short-name.js and export
// `up(db, ctx)` (see docs/MIGRATIONS.md). Applied migrations are recorded in
// the `schema_migrations` collection (id, checksum, timestamps, counts).
//
// Rules the runner enforces:
//   - migrations run in numeric order, each at most once (the record's _id is
//     claimed with a unique insert before `up` runs, so two concurrent runs
//     cannot both apply it);
//   - an applied migration whose file changed (checksum) or disappeared stops
//     the run: add a new migration instead of editing an old one;
//   - a not-yet-applied migration numbered below an applied one stops the run;
//   - a failed `up` is not recorded as applied, and later migrations do not run.
//
// Reads MONGODB_URI from the environment / .env (the old ATLASDB_URL is still
// accepted), like scripts/seed.js. Never prints the connection string.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const COLLECTION = "schema_migrations";
const FILE_PATTERN = /^(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.js$/;
const DUPLICATE_KEY = 11000;

class MigrationError extends Error {
  constructor(message, problems = [], options = undefined) {
    super(
      problems.length
        ? `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
        : message,
      options,
    );
    this.name = "MigrationError";
    this.problems = problems;
  }
}

/**
 * SHA-256 of a migration's source with line endings normalised, so the same
 * file has the same checksum on Windows (CRLF) and Linux (LF).
 */
function checksumOf(source) {
  return crypto
    .createHash("sha256")
    .update(source.replace(/\r\n/g, "\n"))
    .digest("hex");
}

/**
 * Reads and validates the migration files in `dir`, sorted by number.
 * Every *.js file there must be a migration named NNN-short-name.js.
 */
function loadMigrations(dir = MIGRATIONS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new MigrationError(`Migrations folder not found: ${dir}`);
    }
    throw err;
  }

  const migrations = [];
  for (const file of entries.filter((f) => f.endsWith(".js")).sort()) {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new MigrationError(
        `Invalid migration file name "${file}". Use NNN-short-name.js with lowercase letters, digits and hyphens, e.g. 002-add-user-email-index.js.`,
      );
    }
    const fullPath = path.join(dir, file);
    const source = fs.readFileSync(fullPath, "utf8");
    // Drop any cached copy so a file changed between two loads in the same
    // process (tests) is read again; the CLI loads each file once.
    delete require.cache[fullPath];
    const mod = require(fullPath);
    if (!mod || typeof mod.up !== "function") {
      throw new MigrationError(
        `Migration ${file} must export an up(db, ctx) function.`,
      );
    }
    migrations.push({
      id: file.slice(0, -3),
      number: Number(match[1]),
      name: match[2],
      file: fullPath,
      checksum: checksumOf(source),
      up: mod.up,
    });
  }

  migrations.sort((a, b) => a.number - b.number);
  for (let i = 1; i < migrations.length; i += 1) {
    if (migrations[i].number === migrations[i - 1].number) {
      throw new MigrationError(
        `Two migrations share the number ${migrations[i].number}: ${migrations[i - 1].id} and ${migrations[i].id}.`,
      );
    }
  }
  return migrations;
}

// --- Dry-run guard ---------------------------------------------------------
// In a dry run `up` receives a read-only view of the database: any call that
// writes throws, so a dry run cannot change data even if a migration forgets
// to look at ctx.dryRun. It blocks the driver's write methods and aggregate
// pipelines with $out/$merge. It is a safety net, not a sandbox: a migration
// can still reach the real database through db.client.
const COLLECTION_WRITES = new Set([
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "bulkWrite",
  "initializeOrderedBulkOp",
  "initializeUnorderedBulkOp",
  "createIndex",
  "createIndexes",
  "dropIndex",
  "dropIndexes",
  "drop",
  "rename",
]);
const DB_WRITES = new Set([
  "command",
  "createCollection",
  "createIndex",
  "dropCollection",
  "dropDatabase",
  "renameCollection",
]);

function dryRunViolation(what) {
  return new MigrationError(
    `Dry run: the migration tried to write (${what}). Check ctx.dryRun and skip writes (only report counts) when it is true.`,
  );
}

function guardAggregate(target) {
  return (pipeline = [], ...rest) => {
    const writes = (Array.isArray(pipeline) ? pipeline : []).some(
      (stage) => stage && ("$out" in stage || "$merge" in stage),
    );
    if (writes) throw dryRunViolation("aggregate with $out/$merge");
    return target.aggregate(pipeline, ...rest);
  };
}

function readOnlyCollection(collection) {
  return new Proxy(collection, {
    get(target, prop) {
      if (COLLECTION_WRITES.has(prop)) {
        return () => {
          throw dryRunViolation(`collection.${prop}`);
        };
      }
      if (prop === "aggregate") return guardAggregate(target);
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function readOnlyDb(db) {
  return new Proxy(db, {
    get(target, prop) {
      if (DB_WRITES.has(prop)) {
        return () => {
          throw dryRunViolation(`db.${prop}`);
        };
      }
      if (prop === "collection") {
        return (...args) => readOnlyCollection(target.collection(...args));
      }
      if (prop === "aggregate") return guardAggregate(target);
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// --- History checks --------------------------------------------------------

/** Throws if the recorded history does not match the files on disk. */
function verifyHistory(migrations, records) {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const problems = [];

  for (const record of records) {
    const migration = byId.get(record._id);
    if (record.status === "running") {
      problems.push(
        `${record._id} is marked as running: another migration run is in progress, or an earlier run was interrupted. If no run is active, check whether its changes were applied, then delete the record (db.${COLLECTION}.deleteOne({ _id: "${record._id}" })) and run again.`,
      );
    } else if (!migration) {
      problems.push(
        `${record._id} was applied but its file is missing from scripts/migrations. Restore it; never delete or rename an applied migration.`,
      );
    } else if (record.checksum !== migration.checksum) {
      problems.push(
        `${record._id} was changed after it was applied (checksum mismatch). Revert the edit and put the change in a new migration.`,
      );
    }
  }

  const appliedIds = new Set(records.map((r) => r._id));
  let latest = null;
  for (const m of migrations) {
    if (appliedIds.has(m.id) && (!latest || m.number > latest.number)) {
      latest = m;
    }
  }
  if (latest) {
    for (const m of migrations) {
      if (!appliedIds.has(m.id) && m.number < latest.number) {
        problems.push(
          `${m.id} is numbered below the latest applied migration (${latest.id}) but was never applied. Renumber it above ${latest.id}.`,
        );
      }
    }
  }

  if (problems.length) {
    throw new MigrationError(
      "Migration history does not match the migration files. Nothing was run.",
      problems,
    );
  }
}

function normalizeResult(result) {
  return result && typeof result === "object" && !Array.isArray(result)
    ? result
    : null;
}

function formatCounts(result) {
  const entries = result ? Object.entries(result) : [];
  return entries.length
    ? entries.map(([key, value]) => `${key}=${value}`).join(", ")
    : "no counts reported";
}

/**
 * Applies (or, with dryRun, previews) the pending migrations.
 *
 * @param {object}   options
 * @param {object}   options.db       native MongoDB Db (mongoose.connection.db)
 * @param {string}   [options.dir]    migrations folder
 * @param {boolean}  [options.dryRun] run `up` against a read-only db, record nothing
 * @param {Function} [options.log]    receives one line of text per message
 * @param {Function} [options.now]    clock, replaceable in tests
 * @returns {Promise<{dryRun: boolean, skipped: string[], pending: string[], applied: string[]}>}
 *   `pending` is what was pending when the run started; `applied` is what was
 *   recorded (always empty in a dry run).
 */
async function runMigrations({
  db,
  dir = MIGRATIONS_DIR,
  dryRun = false,
  log = () => {},
  now = () => new Date(),
}) {
  const migrations = loadMigrations(dir);
  const collection = db.collection(COLLECTION);
  const records = await collection.find({}).toArray();
  verifyHistory(migrations, records);

  const appliedIds = new Set(records.map((r) => r._id));
  const skipped = migrations
    .filter((m) => appliedIds.has(m.id))
    .map((m) => m.id);
  const pending = migrations.filter((m) => !appliedIds.has(m.id));
  const summary = {
    dryRun,
    skipped,
    pending: pending.map((m) => m.id),
    applied: [],
  };

  if (!pending.length) {
    log(`Nothing to do: ${skipped.length} migration(s) already applied.`);
    return summary;
  }
  log(
    `${pending.length} pending migration(s), ${skipped.length} already applied.`,
  );

  for (const migration of pending) {
    const scopedLog = (message) => log(`  ${migration.id}: ${message}`);

    if (dryRun) {
      log(`[dry run] ${migration.id}: previewing`);
      const result = normalizeResult(
        await migration.up(readOnlyDb(db), { dryRun: true, log: scopedLog }),
      );
      log(`[dry run] ${migration.id}: would apply (${formatCounts(result)})`);
      continue;
    }

    log(`Applying ${migration.id} ...`);
    try {
      await collection.insertOne({
        _id: migration.id,
        name: migration.name,
        checksum: migration.checksum,
        status: "running",
        startedAt: now(),
      });
    } catch (err) {
      if (err && err.code === DUPLICATE_KEY) {
        throw new MigrationError(
          `${migration.id} is already applied or being applied by another process. It was not run again.`,
        );
      }
      throw err;
    }

    const started = Date.now();
    let result;
    try {
      result = normalizeResult(
        await migration.up(db, { dryRun: false, log: scopedLog }),
      );
    } catch (err) {
      await collection
        .deleteOne({ _id: migration.id, status: "running" })
        .catch(() => {});
      throw new MigrationError(
        `${migration.id} failed and was not recorded as applied: ${err && err.message ? err.message : err}. Fix the cause and run again (a migration must be safe to repeat if it stopped half-way).`,
        [],
        { cause: err },
      );
    }

    const durationMs = Date.now() - started;
    await collection.updateOne(
      { _id: migration.id },
      { $set: { status: "applied", appliedAt: now(), durationMs, result } },
    );
    summary.applied.push(migration.id);
    log(
      `Applied ${migration.id} in ${durationMs} ms (${formatCounts(result)})`,
    );
  }

  log(
    dryRun
      ? `Dry run finished: ${pending.length} migration(s) would be applied; nothing was written.`
      : `Done: ${summary.applied.length} migration(s) applied.`,
  );
  return summary;
}

// --- Command line ------------------------------------------------------------

function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== "--dry-run");
  if (unknown.length) {
    throw new MigrationError(
      `Unknown argument: ${unknown.join(" ")}. The only option is --dry-run.`,
    );
  }
  return { dryRun: argv.includes("--dry-run") };
}

function resolveMongoUri(env = process.env) {
  const uri = (env.MONGODB_URI || env.ATLASDB_URL || "").trim();
  if (!uri) {
    throw new MigrationError(
      "MONGODB_URI is not set. Copy .env.example to .env and set it (or export it) before migrating.",
    );
  }
  return uri;
}

async function main(
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
) {
  const { dryRun } = parseArgs(argv);
  const uri = resolveMongoUri(env);
  if (env.DNS_SERVERS) {
    const servers = env.DNS_SERVERS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (servers.length) require("node:dns").setServers(servers);
  }

  const mongoose = require("mongoose");
  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db;
    log(`Database: ${db.databaseName}${dryRun ? " (dry run)" : ""}`);
    return await runMigrations({ db, dryRun, log });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  main().catch((err) => {
    console.error(
      err instanceof MigrationError ? `Migration stopped: ${err.message}` : err,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  MIGRATIONS_DIR,
  COLLECTION,
  MigrationError,
  checksumOf,
  loadMigrations,
  readOnlyDb,
  verifyHistory,
  runMigrations,
  parseArgs,
  resolveMongoUri,
  main,
};
