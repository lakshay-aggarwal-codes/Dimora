// Builds a throw-away migrations folder for tests.
//
//   const dir = makeMigrationsDir({
//     "001-first.js": migrationSource(),
//     "002-second.js": migrationSource({ result: { users: 3 } }),
//   });
//
// Folders are created under the OS temp directory and removed by
// cleanupMigrationsDirs() (call it in afterEach). Each migration records its
// run in global.__migrationCalls as { id, dryRun } so tests can assert order.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const created = [];

function makeMigrationsDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimora-migrations-"));
  created.push(dir);
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), source);
  }
  return dir;
}

function cleanupMigrationsDirs() {
  while (created.length) {
    fs.rmSync(created.pop(), { recursive: true, force: true });
  }
  global.__migrationCalls = [];
}

/**
 * Source text of a migration. Options:
 *   id       label stored in the call log (default: the file name without .js)
 *   result   object returned from up()
 *   body     extra statements run inside up(db, ctx) before returning
 *   comment  text added as a comment (changes the checksum)
 */
function migrationSource({ id, result = {}, body = "", comment = "" } = {}) {
  return `${comment ? `// ${comment}\n` : ""}module.exports = {
  async up(db, ctx) {
    global.__migrationCalls = global.__migrationCalls || [];
    global.__migrationCalls.push({ id: ${JSON.stringify(id || "")} || require("node:path").basename(__filename, ".js"), dryRun: ctx.dryRun });
    ${body}
    return ${JSON.stringify(result)};
  },
};
`;
}

module.exports = { makeMigrationsDir, cleanupMigrationsDirs, migrationSource };
