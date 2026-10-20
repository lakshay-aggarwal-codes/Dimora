// Makes an existing account an admin (P14-T01). The only way to do it.
//
//   npm run make-admin -- you@example.com
//
// Reads MONGODB_URI from the environment / .env (the old ATLASDB_URL is still
// accepted). Writes one audit-log row. Never prints the connection string.
// Works in production on purpose: that is where the first admin is needed.
const mongoose = require("mongoose");
const { promoteToAdmin, BootstrapError } = require("../src/services/adminBootstrap");

function parseArgs(argv) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    throw new BootstrapError("Usage: npm run make-admin -- <email>");
  }
  return { email: argv[0] };
}

function resolveMongoUri(env = process.env) {
  const uri = (env.MONGODB_URI || env.ATLASDB_URL || "").trim();
  if (!uri) {
    throw new BootstrapError("MONGODB_URI is not set. Set it in .env (or the shell) first.");
  }
  return uri;
}

async function main(argv = process.argv.slice(2)) {
  require("dotenv").config({ quiet: true });
  const { email } = parseArgs(argv);
  await mongoose.connect(resolveMongoUri());
  try {
    const { changed, username } = await promoteToAdmin(email);
    console.log(
      changed
        ? `"${username}" is now an admin. Open /admin after logging in (an open session picks the new role up on its next request).`
        : `"${username}" is already an admin; nothing changed.`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof BootstrapError ? `make-admin failed: ${err.message}` : err);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, resolveMongoUri, main };
