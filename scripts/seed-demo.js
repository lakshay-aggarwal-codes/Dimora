// Fills a DEVELOPMENT database with demo data for walking through the whole
// product (P19-T02): about 30 published places with five photos each, four
// demo accounts (host, two guests, admin) and sample bookings in every state.
//
//   npm run seed:demo                     create or refresh (safe to run again)
//   npm run seed:demo -- --reset          delete the demo host's places and everything
//                                         attached to them (bookings, night ledger, reviews,
//                                         saves, conversations), then create it all again
//   npm run seed:demo -- --rotate-passwords   give the existing demo accounts new passwords
//   npm run seed:demo -- --yes            needed when MONGODB_URI is not on this computer
//
// Safety: refuses to run when NODE_ENV=production; a database that is not on
// this computer (Atlas, any remote host) is only touched with --yes, and the
// target is printed first (without credentials).
//
// DEMO ACCOUNTS ARE FOR DEMONSTRATION ONLY. Their passwords are random, made
// when an account is created (or rotated) and printed once; none is stored in
// the code, so none is reused anywhere. The addresses end in .invalid.
//
// What the bookings are: made through the real services (reservations.create /
// transition, cancellations.cancelBooking, reviews.submit) with a clock that
// is set back, so the night ledger, price snapshot, refund and history are what
// the app itself writes. Two requests are waiting for the host; like any
// request they hold their nights for 24 hours and then expire (the sweeper
// does it), so run `--reset` for fresh ones. No notifications or emails are
// sent. Payments are simulated, as everywhere in Dimora.
const mongoose = require("mongoose");
const Listing = require("../src/models/listing.js");
const Review = require("../src/models/review.js");
const User = require("../src/models/user.js");
const Reservation = require("../src/models/reservation.js");
const StayNight = require("../src/models/stayNight.js");
const AvailabilityBlock = require("../src/models/availabilityBlock.js");
const WishlistItem = require("../src/models/wishlistItem.js");
const ListingStat = require("../src/models/listingStat.js");
const Conversation = require("../src/models/conversation.js");
const Message = require("../src/models/message.js");
const { SeedError, assertSeedAllowed, resolveMongoUri } = require("./seed.js");
const { DEMO_ACCOUNTS, buildDemoListings, planReservations } = require("./demo-data.js");
const { isLocalUri, describeTarget, generatePassword } = require("./lib/demo-guards.js");
const { createReservationService, PENDING_HOLD_MS } = require("../src/services/reservations.js");
const { createReviewService } = require("../src/services/reviews.js");
const { cancelBooking } = require("../src/services/cancellations.js");
const { promoteToAdmin } = require("../src/services/adminBootstrap.js");
const { configureLocationSecret } = require("../src/utils/geo.js");
const { todayIn, DEFAULT_TIMEZONE } = require("../src/utils/dates.js");
const { AppError } = require("../src/utils/errors.js");

const MS_HOUR = 60 * 60 * 1000;
const OPTIONS = ["--reset", "--rotate-passwords", "--yes"];

function parseArgs(argv) {
  const unknown = argv.filter((arg) => !OPTIONS.includes(arg));
  if (unknown.length) {
    throw new SeedError(`Unknown argument: ${unknown.join(" ")}. Options: ${OPTIONS.join(", ")}.`);
  }
  return {
    reset: argv.includes("--reset"),
    rotatePasswords: argv.includes("--rotate-passwords"),
    yes: argv.includes("--yes"),
  };
}

const isDuplicate = (err) => Boolean(err) && (err.code === 11000 || err.name === "UserExistsError");

/**
 * Finds the demo account or creates it with a new random password. An account
 * that already exists keeps its password unless `rotate` is set. Returns the
 * password only when one was just set.
 */
async function ensureAccount(spec, { rotate = false } = {}) {
  let user = await User.findOne({ username: spec.username });
  if (!user) {
    const password = generatePassword();
    try {
      user = await User.register(
        new User({
          username: spec.username,
          email: spec.email,
          displayName: spec.displayName,
          bio: spec.bio,
        }),
        password,
      );
    } catch (err) {
      if (isDuplicate(err)) {
        throw new SeedError(
          `Cannot create ${spec.username}: that username or ${spec.email} is already taken by another account.`,
        );
      }
      throw err;
    }
    return { user, password, created: true };
  }
  if (user.status && user.status !== "active") {
    throw new SeedError(`The demo account ${spec.username} is ${user.status}. Reinstate it, or delete it and run again.`);
  }
  if (!rotate) return { user, password: null, created: false };
  const password = generatePassword();
  await user.setPassword(password);
  await user.save();
  await User.updateOne({ _id: user._id }, { $set: { attempts: 0 } }); // lift a failed-login lock
  return { user, password, created: false };
}

/** Deletes the demo host's places and everything that hangs on them. */
async function resetDemoData(host) {
  const listings = await Listing.find({ owner: host._id }, { _id: 1, reviews: 1 }).lean();
  const ids = listings.map((l) => l._id);
  const reviewIds = listings.flatMap((l) => l.reviews || []);
  const conversationIds = (await Conversation.find({ listing: { $in: ids } }, { _id: 1 }).lean()).map((c) => c._id);

  await Message.deleteMany({ conversation: { $in: conversationIds } });
  await Conversation.deleteMany({ _id: { $in: conversationIds } });
  await StayNight.deleteMany({ listing: { $in: ids } });
  await AvailabilityBlock.deleteMany({ listing: { $in: ids } });
  await Reservation.deleteMany({ listing: { $in: ids } });
  await Review.deleteMany({ $or: [{ listing: { $in: ids } }, { _id: { $in: reviewIds } }] });
  await WishlistItem.deleteMany({ listing: { $in: ids } });
  await ListingStat.deleteMany({ listing: { $in: ids } });
  const removed = (await Listing.deleteMany({ owner: host._id })).deletedCount;
  await User.updateOne({ _id: host._id }, { $set: { hostCancellationCount: 0 } });
  return { removed };
}

async function upsertListings(hostId) {
  const docs = buildDemoListings(hostId);
  const result = await Listing.bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { owner: hostId, title: doc.title },
        update: { $set: doc, $unset: { deletedAt: 1, hiddenByOwnerSuspension: 1 } },
        upsert: true,
      },
    })),
  );
  // bulkWrite skips the model's validate hook: saving once sets the public
  // (approximate) point of each new listing (P06-T02).
  const needPoint = await Listing.find({ owner: hostId, publicGeometry: { $exists: false } });
  for (const doc of needPoint) await doc.save();
  const stored = await Listing.find({ owner: hostId, title: { $in: docs.map((d) => d.title) } });
  return { created: result.upsertedCount, updated: result.matchedCount, byTitle: new Map(stored.map((l) => [l.title, l])) };
}

const isRefusal = (err) => err instanceof AppError;

/** Drives one booking to its final state. Each step only runs from the state it
 *  expects, so a re-run (or a state the app has moved on from) is left alone. */
async function advance(plan, reservation, ctx) {
  const { service, users, now } = ctx;
  const id = reservation._id;
  const status = reservation.status;
  switch (plan.final) {
    case "confirmed":
      if (status === "pending") {
        await service.transition(id, "confirmed", { actor: "host", by: users.host._id, now: plan.respondedAt });
      }
      break;
    case "declined":
      if (status === "pending") {
        await service.transition(id, "declined", {
          actor: "host",
          by: users.host._id,
          reason: plan.reason,
          now: plan.respondedAt,
        });
      }
      break;
    case "expired":
      if (status === "pending") {
        const lapsed = new Date(plan.bookedAt.getTime() + PENDING_HOLD_MS + 5 * 60 * 1000);
        await service.transition(id, "expired", { actor: "system", now: lapsed });
      }
      break;
    case "cancelled_by_guest":
    case "cancelled_by_host":
      if (status === "confirmed") {
        const byGuest = plan.final === "cancelled_by_guest";
        await cancelBooking(
          { reservationService: service },
          { id, user: byGuest ? users[plan.guest] : users.host, reason: plan.reason, now },
        );
      }
      break;
    case "completed":
      if (status === "confirmed") {
        const endOfStay = new Date(Date.parse(`${plan.checkOut}T00:00:00Z`) + 12 * MS_HOUR);
        await service.transition(id, "completed", { actor: "system", now: endOfStay });
      }
      break;
    default: // "pending": nothing to do
  }
  return Reservation.findById(id);
}

async function addReview(plan, reservation, ctx) {
  if (!plan.review || reservation.status !== "completed") return false;
  if (await Review.exists({ reservation: reservation._id })) return false;
  const guest = ctx.users[plan.guest];
  const review = await ctx.reviews.submit({
    user: guest,
    listingId: reservation.listing,
    reservationId: reservation._id,
    rating: plan.review.rating,
    comment: plan.review.comment,
    now: ctx.now,
    windowDays: 365, // the stays are backdated; the app's own window applies to real guests
  });
  const wrote = new Date(Math.min(ctx.now.getTime(), Date.parse(`${plan.checkOut}T00:00:00Z`) + 33 * MS_HOUR));
  await Review.updateOne({ _id: review._id }, { $set: { createdAt: wrote, updatedAt: wrote } }, { timestamps: false });
  return true;
}

async function runScenario(plan, ctx) {
  const guest = ctx.users[plan.guest];
  const listing = ctx.listings.get(plan.listing);
  if (!listing) return { key: plan.key, problem: `listing "${plan.listing}" was not found` };

  let reservation = await Reservation.findOne({ guest: guest._id, idempotencyKey: plan.idempotencyKey });
  let created = false;
  try {
    if (!reservation) {
      const made = await ctx.service.create(
        {
          guest,
          listing: listing._id,
          in: plan.checkIn,
          out: plan.checkOut,
          guests: plan.guests,
          idempotencyKey: plan.idempotencyKey,
        },
        { now: plan.bookedAt },
      );
      reservation = made.reservation;
      created = made.created;
      // Booked "then", not now: the booking page and the refund rules read createdAt.
      await Reservation.updateOne(
        { _id: reservation._id },
        { $set: { createdAt: plan.bookedAt, updatedAt: plan.bookedAt } },
        { timestamps: false },
      );
    }
    reservation = await advance(plan, reservation, ctx);
    const reviewed = await addReview(plan, reservation, ctx);
    return { key: plan.key, created, status: reservation.status, reviewed };
  } catch (err) {
    if (!isRefusal(err)) throw err;
    // e.g. the nights are already taken in this database: report it, keep going.
    return { key: plan.key, problem: err.message };
  }
}

/**
 * Creates or refreshes the demo data. Needs an open mongoose connection.
 * Dates are relative to `now`. Returns what happened; `accounts[name].password`
 * is set only for accounts created or rotated in this run.
 */
async function runDemoSeed({ reset = false, rotatePasswords = false, now = new Date(), log = () => {} } = {}) {
  assertSeedAllowed();
  const secret = process.env.SESSION_SECRET;
  if (typeof secret === "string" && secret.length >= 16) configureLocationSecret(secret);

  // Everything is validated before anything is written.
  for (const doc of buildDemoListings(new mongoose.Types.ObjectId())) {
    const error = new Listing(doc).validateSync();
    if (error) throw new SeedError(`Demo listing "${doc.title}" is invalid: ${error.message}`);
  }

  const accounts = {};
  const users = {};
  for (const [name, spec] of Object.entries(DEMO_ACCOUNTS)) {
    accounts[name] = await ensureAccount(spec, { rotate: rotatePasswords });
    users[name] = accounts[name].user;
  }
  if (users.admin.role !== "admin") await promoteToAdmin(users.admin.email);

  let removed = 0;
  if (reset) {
    removed = (await resetDemoData(users.host)).removed;
    log(`Removed ${removed} demo places and everything attached to them`);
  }

  const listings = await upsertListings(users.host._id);
  log(`Demo places: ${listings.created} created, ${listings.updated} already present`);

  const ctx = {
    users,
    listings: listings.byTitle,
    now,
    service: createReservationService(), // no notifier: the demo sends nothing
    reviews: createReviewService(),
  };
  const today = todayIn(DEFAULT_TIMEZONE, now);
  const outcomes = [];
  for (const plan of planReservations(today, now)) outcomes.push(await runScenario(plan, ctx));

  const ids = [...listings.byTitle.values()].map((l) => l._id);
  const byStatus = {};
  for (const r of await Reservation.find({ listing: { $in: ids } }, { status: 1 }).lean()) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  return {
    accounts,
    removed,
    listings: { created: listings.created, updated: listings.updated, total: listings.byTitle.size },
    reservations: {
      created: outcomes.filter((o) => o.created).length,
      reviewsCreated: outcomes.filter((o) => o.reviewed).length,
      byStatus,
      problems: outcomes.filter((o) => o.problem).map((o) => `${o.key}: ${o.problem}`),
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  // .env first (NODE_ENV may be set there); dotenv never overrides the shell.
  require("dotenv").config({ quiet: true });
  assertSeedAllowed();
  const options = parseArgs(argv);
  const uri = resolveMongoUri();
  console.log(`Target database: ${describeTarget(uri)}`);
  if (!isLocalUri(uri) && !options.yes) {
    throw new SeedError(
      "That database is not on this computer. Check the target above is a development database, then run again with --yes.",
    );
  }

  // Same DNS override as the other scripts: Atlas "mongodb+srv" lookups fail on
  // some networks unless DNS_SERVERS (for example 8.8.8.8,1.1.1.1) is set.
  const dnsServers = (process.env.DNS_SERVERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (dnsServers.length) require("node:dns").setServers(dnsServers);

  await mongoose.connect(uri);
  try {
    const summary = await runDemoSeed({ ...options, log: console.log });
    const { byStatus, problems } = summary.reservations;
    console.log(
      `Bookings: ${summary.reservations.created} created now; in the database: ` +
        (Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(", ") || "none"),
    );
    console.log(`Reviews created now: ${summary.reservations.reviewsCreated}`);
    for (const problem of problems) console.log(`NOT CREATED - ${problem}`);

    const shown = Object.entries(summary.accounts).filter(([, a]) => a.password);
    if (shown.length) {
      console.log("\nDEMO ACCOUNTS (demonstration only; passwords are shown once and stored nowhere):");
      for (const [role, a] of shown) {
        console.log(`  ${role.padEnd(6)} ${a.user.username}  ${a.user.email}  password: ${a.password}`);
      }
    }
    const hidden = Object.entries(summary.accounts).filter(([, a]) => !a.password).map(([role]) => role);
    if (hidden.length) {
      console.log(`Existing accounts keep their passwords (${hidden.join(", ")}); --rotate-passwords sets new ones.`);
    }
    console.log("Waiting requests hold their nights for 24 hours; --reset makes fresh ones.");
    if (problems.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof SeedError ? `Demo seed failed: ${err.message}` : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  isLocalUri,
  describeTarget,
  generatePassword,
  ensureAccount,
  resetDemoData,
  runDemoSeed,
};
