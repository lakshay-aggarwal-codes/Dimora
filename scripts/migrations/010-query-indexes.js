// Query indexes (P18-T02). Reviews every hot query against the indexes
// (docs/PERFORMANCE.md) and changes the set:
//
//   adds    listings      status_1__id_-1                               home, map "anywhere"
//                         status_1_createdAt_-1__id_-1                  search, newest
//                         status_1_ratingAvg_-1_ratingCount_-1__id_-1   search, relevance / rating
//                         status_1_pricing.nightlyMinor_1__id_1         search, price (both ways)
//           reservations  host_1_status_1_holdExpiresAt_1__id_1         host inbox, pending
//                         host_1_status_1_checkIn_1__id_1               host inbox, confirmed
//           staynights    date_1_listing_1_holdExpiresAt_1              search with dates
//           auditlogs     createdAt_-1__id_-1                           the audit page, newest first
//   drops   listings      status_1_address.city_1       no query filters by address.city
//                         pricing.nightlyMinor_1        replaced by the price index above
//           reservations  host_1_status_1               a prefix of the two new ones
//           auditlogs     createdAt_-1                  a prefix of the new one
//
// Adding is safe on a live database (createIndex with the same name and keys
// is a no-op the second time). Dropping happens AFTER the new indexes exist, and
// only drops what is there. The models declare the same names, so a fresh
// database gets them from Mongoose; this migration is for existing ones.
const ADD = [
  ["listings", { status: 1, _id: -1 }, "status_1__id_-1"],
  [
    "listings",
    { status: 1, createdAt: -1, _id: -1 },
    "status_1_createdAt_-1__id_-1",
  ],
  [
    "listings",
    { status: 1, ratingAvg: -1, ratingCount: -1, _id: -1 },
    "status_1_ratingAvg_-1_ratingCount_-1__id_-1",
  ],
  [
    "listings",
    { status: 1, "pricing.nightlyMinor": 1, _id: 1 },
    "status_1_pricing.nightlyMinor_1__id_1",
  ],
  [
    "reservations",
    { host: 1, status: 1, holdExpiresAt: 1, _id: 1 },
    "host_1_status_1_holdExpiresAt_1__id_1",
  ],
  [
    "reservations",
    { host: 1, status: 1, checkIn: 1, _id: 1 },
    "host_1_status_1_checkIn_1__id_1",
  ],
  [
    "staynights",
    { date: 1, listing: 1, holdExpiresAt: 1 },
    "date_1_listing_1_holdExpiresAt_1",
  ],
  ["auditlogs", { createdAt: -1, _id: -1 }, "createdAt_-1__id_-1"],
];

// [collection, name, the keys it had, so `down` can build it again]
const DROP = [
  ["listings", "status_1_address.city_1", { status: 1, "address.city": 1 }],
  ["listings", "pricing.nightlyMinor_1", { "pricing.nightlyMinor": 1 }],
  ["reservations", "host_1_status_1", { host: 1, status: 1 }],
  ["auditlogs", "createdAt_-1", { createdAt: -1 }],
];

const NOT_FOUND = new Set([26, 27]); // NamespaceNotFound, IndexNotFound

async function dropIfThere(collection, name) {
  try {
    await collection.dropIndex(name);
    return true;
  } catch (err) {
    if (
      err &&
      (NOT_FOUND.has(err.code) ||
        /index not found|ns not found/i.test(err.message || ""))
    ) {
      return false;
    }
    throw err;
  }
}

module.exports = {
  ADD,
  DROP,

  async up(db, ctx = {}) {
    if (ctx.dryRun) return { toAdd: ADD.length, toDrop: DROP.length };
    for (const [name, keys, indexName] of ADD) {
      await db.collection(name).createIndex(keys, { name: indexName });
    }
    let dropped = 0;
    for (const [name, indexName] of DROP) {
      if (await dropIfThere(db.collection(name), indexName)) dropped += 1;
    }
    return { added: ADD.length, dropped };
  },

  // Manual rollback: the old indexes come back, the new ones go.
  async down(db, ctx = {}) {
    if (ctx.dryRun) return { toAdd: DROP.length, toDrop: ADD.length };
    for (const [name, indexName, keys] of DROP) {
      await db.collection(name).createIndex(keys, { name: indexName });
    }
    let dropped = 0;
    for (const [name, , indexName] of ADD) {
      if (await dropIfThere(db.collection(name), indexName)) dropped += 1;
    }
    return { added: DROP.length, dropped };
  },
};
