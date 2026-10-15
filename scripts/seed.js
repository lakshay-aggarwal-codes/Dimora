// Seeds a DEVELOPMENT database with the 29 sample listings and a demo host.
//
//   npm run seed                 add/refresh the sample listings (idempotent)
//   npm run seed -- --reset      first delete the demo host's listings (and
//                                the reviews on them), then re-create them
//
// Reads MONGODB_URI from the environment / .env (the old ATLASDB_URL is still
// accepted). Refuses to run when NODE_ENV=production. Coordinates are
// hard-coded in scripts/seed-data.js, so no Mapbox or Cloudinary key is needed.
// Only the demo host's listings are ever touched; other users' data is not.
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Listing = require("../src/models/listing.js");
const Review = require("../src/models/review.js");
const User = require("../src/models/user.js");
const { data: sampleListings } = require("./seed-data.js");
const {
  rupeesToMinor,
  addressFromLegacy,
  imagesFromCover,
} = require("../src/utils/listingFields");

const DEMO_HOST = Object.freeze({
  username: "dimora_demo_host",
  email: "demo-host@dimora.invalid", // .invalid never resolves: no real mailbox
});

class SeedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeedError";
  }
}

function assertSeedAllowed(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new SeedError(
      "Refusing to seed: NODE_ENV is production. The seed script is for development databases only.",
    );
  }
}

function resolveMongoUri(env = process.env) {
  const uri = (env.MONGODB_URI || env.ATLASDB_URL || "").trim();
  if (!uri) {
    throw new SeedError(
      "MONGODB_URI is not set. Copy .env.example to .env and set it (or export it) before seeding.",
    );
  }
  return uri;
}

function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== "--reset");
  if (unknown.length) {
    throw new SeedError(
      `Unknown argument: ${unknown.join(" ")}. The only option is --reset.`,
    );
  }
  return { reset: argv.includes("--reset") };
}

/**
 * The sample listings for one owner, in the v2 listing shape. The seed data
 * keeps its simple form (`price` in rupees); this converts it. Does not modify
 * the seed data.
 */
function buildSeedListings(ownerId) {
  return sampleListings.map(({ price, ...item }) => ({
    ...item,
    status: "published",
    pricing: { nightlyMinor: rupeesToMinor(price), currency: "INR" },
    address: addressFromLegacy(item.location, item.country),
    images: imagesFromCover(item.image),
    owner: ownerId,
  }));
}

async function ensureDemoHost() {
  const existing = await User.findOne({ username: DEMO_HOST.username });
  if (existing) return { user: existing, password: null };

  const password = crypto.randomBytes(18).toString("base64url");
  const user = await User.register(
    new User({ username: DEMO_HOST.username, email: DEMO_HOST.email }),
    password,
  );
  return { user, password };
}

/**
 * Creates the demo host if needed and upserts the sample listings by
 * (owner, title), so running it again changes nothing and never duplicates.
 * Needs an open mongoose connection; does not open or close one.
 */
async function runSeed({ reset = false } = {}) {
  // Validate everything before writing anything.
  const probeOwner = new mongoose.Types.ObjectId();
  for (const doc of buildSeedListings(probeOwner)) {
    const error = new Listing(doc).validateSync();
    if (error) {
      throw new SeedError(`Seed listing "${doc.title}" is invalid: ${error.message}`);
    }
  }

  const { user: owner, password } = await ensureDemoHost();

  let removed = 0;
  if (reset) {
    const mine = await Listing.find({ owner: owner._id }, { reviews: 1 });
    const reviewIds = mine.flatMap((listing) => listing.reviews);
    if (reviewIds.length) await Review.deleteMany({ _id: { $in: reviewIds } });
    removed = (await Listing.deleteMany({ owner: owner._id })).deletedCount;
  }

  const result = await Listing.bulkWrite(
    buildSeedListings(owner._id).map((doc) => ({
      updateOne: {
        filter: { owner: owner._id, title: doc.title },
        update: { $set: doc },
        upsert: true,
      },
    })),
  );

  return {
    owner,
    generatedPassword: password,
    removed,
    created: result.upsertedCount,
    updated: result.matchedCount,
    total: await Listing.countDocuments({ owner: owner._id }),
  };
}

async function main(argv = process.argv.slice(2)) {
  // Load .env first: NODE_ENV may be set there. dotenv never overrides
  // variables that are already set in the shell.
  require("dotenv").config({ quiet: true });
  assertSeedAllowed();
  const { reset } = parseArgs(argv);
  const uri = resolveMongoUri();

  await mongoose.connect(uri);
  console.log("Connected to DB");
  try {
    const summary = await runSeed({ reset });
    if (reset) console.log(`Removed ${summary.removed} existing demo listings`);
    console.log(
      `Demo listings: ${summary.created} created, ${summary.updated} already present, ${summary.total} total`,
    );
    if (summary.generatedPassword) {
      console.log(
        `Created demo host "${DEMO_HOST.username}" with password: ${summary.generatedPassword}`,
      );
      console.log("(shown once; this is a development-only account)");
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      err instanceof SeedError ? `Seed failed: ${err.message}` : err,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  DEMO_HOST,
  SeedError,
  assertSeedAllowed,
  resolveMongoUri,
  parseArgs,
  buildSeedListings,
  runSeed,
};
