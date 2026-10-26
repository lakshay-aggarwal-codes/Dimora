// P18-T02 against MongoDB's own planner: explain("executionStats") for every hot
// query (src/services/queryPlans.js) on a small seeded database. No query may
// scan the collection (except the admin text search, which says why), those
// that promise their order sort nothing in memory, and the availability queries
// for search are answered from the index alone. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/queryPlans.db.test.js
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createUser, createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const Review = require("../../src/models/review");
const Report = require("../../src/models/report");
const AuditLog = require("../../src/models/auditLog");
const {
  hotQueries,
  runExplain,
  violations,
  reviewQueries,
} = require("../../src/services/queryPlans");
const { addDays, todayIn } = require("../../src/utils/dates");

const oid = () => new mongoose.Types.ObjectId();
const TODAY = todayIn();

describeDb("query plans (database)", () => {
  useTestDb();

  async function seed() {
    const host = (await createUser()).user;
    const guest = (await createUser()).user;
    const listings = [];
    for (let i = 0; i < 30; i += 1) {
      listings.push(
        await createListing({
          owner: host,
          title: `Beach stay ${i}`,
          address: {
            line1: "1 Road",
            city: i % 2 ? "Goa" : "Manali",
            state: "X",
            postalCode: "403001",
            country: "India",
          },
        }),
      );
    }
    const nights = [];
    const reservations = [];
    const statuses = [
      "pending",
      "confirmed",
      "completed",
      "cancelled_by_guest",
      "declined",
      "expired",
    ];
    for (let i = 0; i < 120; i += 1) {
      const listing = listings[i % listings.length];
      const checkIn = addDays(TODAY, i % 60);
      nights.push({
        listing: listing._id,
        date: checkIn,
        source: { kind: "reservation", id: oid() },
        createdAt: new Date(),
      });
      reservations.push({
        listing: listing._id,
        guest: i % 3 ? guest._id : oid(),
        host: host._id,
        checkIn,
        checkOut: addDays(checkIn, 2),
        nights: 2,
        guests: 2,
        status: statuses[i % statuses.length],
        holdExpiresAt: addDays(TODAY, 1),
        createdAt: new Date(),
        updatedAt: new Date(),
        idempotencyKey: `plan-key-${i}-abcdefgh`,
      });
    }
    await StayNight.collection.insertMany(nights);
    await Reservation.collection.insertMany(reservations);
    await Review.collection.insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        listing: listings[i]._id,
        author: guest._id,
        reservation: oid(),
        rating: 5,
        comment: "Nice",
        createdAt: new Date(),
      })),
    );
    await Report.collection.insertMany(
      Array.from({ length: 20 }, (_, i) => ({
        reporter: i % 2 ? guest._id : oid(),
        targetKind: "listing",
        targetId: listings[i]._id,
        reason: "spam",
        status: i % 4 ? "open" : "dismissed",
        createdAt: new Date(),
      })),
    );
    await AuditLog.collection.insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        actor: host._id,
        action: "listing.review",
        targetType: "listing",
        targetId: listings[i % 30]._id,
        createdAt: new Date(Date.now() - i * 1000),
      })),
    );
    await Promise.all(
      [Listing, Reservation, StayNight, Review, Report, AuditLog].map((M) =>
        M.init(),
      ),
    );
  }

  test("every hot query keeps what it promises, as MongoDB itself plans it", async () => {
    await seed();
    const failures = [];
    for (const query of hotQueries()) {
      const measured = await runExplain(query);
      const problems = violations(query, measured);
      if (problems.length)
        failures.push({
          id: query.id,
          problems,
          plan: measured.stages.join(">"),
          indexes: measured.indexes,
        });
    }
    expect(failures).toEqual([]);
  });

  test("the search with dates reads only the index (no documents) and the date index is the one used", async () => {
    await seed();
    for (const id of [
      "availability.all_listings_range",
      "availability.flexible_range",
    ]) {
      const query = hotQueries().find((q) => q.id === id);
      const measured = await runExplain(query);
      expect(measured.indexes).toEqual(["date_1_listing_1_holdExpiresAt_1"]);
      expect(measured.docsExamined).toBe(0);
      expect(measured.fetch).toBe(false);
    }
  });

  test("the search orders sort nothing in memory", async () => {
    await seed();
    for (const id of [
      "search.relevance",
      "search.newest",
      "search.price_asc",
      "search.price_desc",
      "home.newest",
      "audit.latest",
      "inbox.pending",
      "inbox.confirmed",
    ]) {
      const measured = await runExplain(hotQueries().find((q) => q.id === id));
      expect({
        id,
        sort: measured.sortInMemory,
        scan: measured.collscan,
      }).toEqual({ id, sort: false, scan: false });
    }
  });

  test("the planner's index for each query is one the checker expected, where the checker names one for a promised order", async () => {
    await seed();
    const promised = reviewQueries().filter(
      (r) =>
        r.noSort &&
        r.index &&
        !r.branches &&
        hotQueries().find((h) => h.id === r.id).noSort,
    );
    for (const r of promised) {
      const measured = await runExplain(
        hotQueries().find((h) => h.id === r.id),
      );
      expect({ id: r.id, ok: measured.indexes.length > 0 }).toEqual({
        id: r.id,
        ok: true,
      });
    }
  });

  test("migration 010's indexes exist after the models are initialised, and the dropped ones do not", async () => {
    await seed();
    const names = async (M) =>
      (await M.collection.indexes()).map((i) => i.name);
    expect(await names(Listing)).toEqual(
      expect.arrayContaining([
        "status_1__id_-1",
        "status_1_createdAt_-1__id_-1",
        "status_1_ratingAvg_-1_ratingCount_-1__id_-1",
        "status_1_pricing.nightlyMinor_1__id_1",
      ]),
    );
    expect(await names(Listing)).not.toContain("status_1_address.city_1");
    expect(await names(Listing)).not.toContain("pricing.nightlyMinor_1");
    expect(await names(Reservation)).toEqual(
      expect.arrayContaining([
        "host_1_status_1_holdExpiresAt_1__id_1",
        "host_1_status_1_checkIn_1__id_1",
      ]),
    );
    expect(await names(Reservation)).not.toContain("host_1_status_1");
    expect(await names(StayNight)).toContain(
      "date_1_listing_1_holdExpiresAt_1",
    );
    expect(await names(AuditLog)).toContain("createdAt_-1__id_-1");
  });

  test("migration 010 on a database that has the old indexes: new ones appear, old ones go, and it can run twice", async () => {
    await seed();
    const migration = require("../../scripts/migrations/010-query-indexes");
    const db = mongoose.connection.db;
    // put the old indexes back, as a database from before this task has them
    await db
      .collection("listings")
      .createIndex(
        { status: 1, "address.city": 1 },
        { name: "status_1_address.city_1" },
      );
    await db
      .collection("listings")
      .createIndex(
        { "pricing.nightlyMinor": 1 },
        { name: "pricing.nightlyMinor_1" },
      );
    await db
      .collection("reservations")
      .createIndex({ host: 1, status: 1 }, { name: "host_1_status_1" });
    await db
      .collection("auditlogs")
      .createIndex({ createdAt: -1 }, { name: "createdAt_-1" });
    const first = await migration.up(db, {});
    expect(first.added).toBe(migration.ADD.length);
    expect(first.dropped).toBe(migration.DROP.length);
    const second = await migration.up(db, {});
    expect(second).toEqual({ added: migration.ADD.length, dropped: 0 });
    const listingNames = (await db.collection("listings").indexes()).map(
      (i) => i.name,
    );
    expect(listingNames).not.toContain("status_1_address.city_1");
    expect(listingNames).toContain("status_1_createdAt_-1__id_-1");
  });
});
