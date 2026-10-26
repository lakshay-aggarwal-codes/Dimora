// Query-plan review (P18-T02): the hot queries of the app, written down as data,
// and a small checker that says, for each one, whether a declared index can
// answer it and whether the index also delivers the sort order.
//
// Used by three things, so they cannot disagree:
//   tests/unit/queryPlans.test.js        every query has a usable index (no
//                                        collection scan) and the ones that
//                                        promise it need no in-memory sort;
//   scripts/explain-queries.js           runs the real explain("executionStats")
//                                        on a database and prints the result;
//   tests/integration/queryPlans.db.test.js  the same check against MongoDB's
//                                        own planner.
//
// The checker is a model of the planner, not the planner: it knows the rules
// that decide the cases in this app (equality fields first, then the sort keys
// in order, direction may be reversed as a whole). MongoDB's explain is the
// authority; the DB test and the script check the model against it.
const { publicListingFilter } = require("../utils/visibility");
const { parseDateOnly } = require("../utils/dates");
const { sortSpec } = require("./search");
const { tabQuery, TABS } = require("./trips");
const { inboxQueries } = require("./hostInbox");

// ---- the checker ------------------------------------------------------------

// Fields with so few values that an index starting with them narrows little.
const LOW_CARDINALITY = new Set([
  "status",
  "targetKind",
  "deletedAt",
  "targetType",
]);
const RANGE_OPS = new Set(["$gt", "$gte", "$lt", "$lte"]);
const GEO_OPS = new Set([
  "$geoWithin",
  "$geoIntersects",
  "$near",
  "$nearSphere",
]);

/** Classifies one field's condition: "eq", "in", "range", "geo" or "other" (not usable: $ne, $nin, regex...). */
function classify(condition) {
  if (condition === null || typeof condition !== "object") return "eq";
  if (condition instanceof Date || typeof condition.toHexString === "function")
    return "eq";
  if (condition instanceof RegExp) return "other";
  const ops = Object.keys(condition);
  if (ops.length && ops.every((op) => op === "$eq")) return "eq";
  if (ops.some((op) => GEO_OPS.has(op))) return "geo";
  if (ops.length && ops.every((op) => op === "$in")) return "in";
  if (ops.length && ops.every((op) => RANGE_OPS.has(op))) return "range";
  if (ops.some((op) => RANGE_OPS.has(op) || op === "$in")) return "range"; // mixed with $ne etc.: the range part still bounds the scan
  return "other";
}

/** Flattens $and and plain keys into { field: kind }; $or / $text are reported apart. */
function constraints(filter) {
  const fields = {};
  const result = { fields, or: null, text: false };
  const visit = (part) => {
    for (const [key, value] of Object.entries(part || {})) {
      if (key === "$and") value.forEach(visit);
      else if (key === "$or") result.or = value;
      else if (key === "$text") result.text = true;
      else if (key.startsWith("$"))
        continue; // $nor, $expr...: no help to an index
      else {
        const kind = classify(value);
        // two conditions on one field: keep the stronger one
        const rank = { other: 0, range: 1, geo: 2, in: 3, eq: 4 };
        if (!fields[key] || rank[kind] > rank[fields[key]]) fields[key] = kind;
      }
    }
  };
  visit(filter);
  return result;
}

const sortEntries = (sort) =>
  Object.entries(sort || {}).filter(([, dir]) => dir === 1 || dir === -1);

/** Does this index, read forwards or backwards, deliver the sort after its equality keys? */
function deliversSort(keys, fields, sort) {
  const wanted = sortEntries(sort);
  if (!wanted.length) return true;
  for (const flip of [1, -1]) {
    let i = 0; // position in the sort
    let ok = true;
    for (const [field, dir] of Object.entries(keys)) {
      if (i >= wanted.length) break;
      if (fields[field] === "eq" && !(wanted[i][0] === field)) continue; // fixed by the filter
      if (field !== wanted[i][0] || dir * flip !== wanted[i][1]) {
        ok = false;
        break;
      }
      i += 1;
    }
    if (ok && i >= wanted.length) return true;
  }
  return false;
}

/**
 * @param {{ filter: object, sort?: object }} query
 * @param {Array<{ name: string, keys: object }>} indexes
 * @returns {{ usable: boolean, index: string|null, noSort: boolean, branches?: object[] }}
 */
function analyse(query, indexes) {
  const { fields, or, text } = constraints(query.filter);
  const sort = query.sort || {};

  if (or) {
    // Every branch must have an index of its own; a merged $or cannot be sorted by one.
    const branches = or.map((branch) =>
      analyse(
        { filter: { ...query.filter, $or: undefined, ...branch }, sort: {} },
        indexes,
      ),
    );
    const usable = branches.every((b) => b.usable);
    return { usable, index: null, noSort: false, branches };
  }

  const candidates = [];
  for (const { name, keys } of indexes) {
    const entries = Object.entries(keys);
    const first = entries[0];
    if (!first) continue;
    let usable = false;
    if (text) usable = Object.values(keys).includes("text");
    else if (Object.values(keys).includes("text")) usable = false;
    else if (Object.values(keys).includes("2dsphere"))
      usable = fields[first[0]] === "geo";
    else if (fields[first[0]] && fields[first[0]] !== "other") usable = true;
    else if (
      !Object.keys(fields).length &&
      sortEntries(sort).length &&
      first[0] === sortEntries(sort)[0][0]
    )
      usable = true;
    if (!usable) continue;
    // how many leading keys the filter constrains (more is a tighter scan)
    let depth = 0;
    for (const [field] of entries) {
      if (fields[field] && fields[field] !== "other") depth += 1;
      else break;
    }
    const noSort =
      !text &&
      !Object.values(keys).includes("2dsphere") &&
      deliversSort(keys, fields, sort);
    const geo = Object.values(keys).includes("2dsphere");
    const score =
      depth * 10 + (noSort ? 5 : 0) + (geo ? 20 : 0) - entries.length * 0.01;
    candidates.push({
      name,
      noSort,
      score,
      lowFirst: LOW_CARDINALITY.has(first[0]),
    });
  }
  if (!candidates.length)
    return { usable: false, index: null, noSort: !sortEntries(sort).length };
  // `status: "confirmed"` matches most of the collection; an index that starts
  // with a person or a listing is the one MongoDB's planner prefers when it has both.
  const selective = candidates.filter((c) => !c.lowFirst);
  const pool = selective.length ? selective : candidates;
  const best = pool.reduce((a, b) => (b.score > a.score ? b : a));
  // The query needs no in-memory sort if ANY usable index delivers the order.
  const noSort = candidates.some((c) => c.noSort);
  return { usable: true, index: best.name, noSort };
}

// ---- the declared indexes ---------------------------------------------------

/** Mongoose's own name for an index that has no explicit one. */
const autoName = (keys) =>
  Object.entries(keys)
    .map(([k, v]) => `${k}_${v}`)
    .join("_");

/** Every index a model declares (field-level `unique`/`index` ones included). */
function declaredIndexes(Model) {
  const list = Model.schema
    .indexes()
    .map(([keys, options]) => ({
      name: (options && options.name) || autoName(keys),
      keys,
      options: options || {},
    }));
  // `_id` is always indexed
  list.push({ name: "_id_", keys: { _id: 1 }, options: {} });
  return list;
}

// ---- the queries --------------------------------------------------------------

const ID = "64b7f0c2a1b2c3d4e5f60718";
const OTHER = "64b7f0c2a1b2c3d4e5f60719";
const DAY = parseDateOnly("2026-12-10");
const LATER = parseDateOnly("2026-12-13");
const NOW = new Date(); // an instant for the examples; dates are only made from values in utils/dates.js
NOW.setTime(Date.UTC(2026, 10, 20, 6));

const q = (id, model, group, source, filter, rest = {}) => ({
  id,
  model,
  group,
  source,
  filter,
  ...rest,
});

/**
 * Each query: where it runs (source), its filter and sort as the service builds
 * them, and what is promised:
 *   noSort    the index must also deliver the order (no in-memory SORT stage);
 *   bounded   a sort in memory is accepted because the set that is sorted is
 *             small by construction (one host's, one guest's, one city's);
 *   scan      a collection scan is accepted, with the reason (admin-only text search).
 * Filters marked "mirrors" are copied from the service by hand; the others call it.
 */
function hotQueries() {
  const inbox = inboxQueries(ID, DAY);
  const tabs = Object.fromEntries(
    TABS.map((t) => [
      t.key || t,
      tabQuery(t.key || t, ID, { now: NOW, today: DAY }),
    ]),
  );
  const published = publicListingFilter();
  const search = (name, extra = {}) => ({
    filter: { ...published, ...extra },
    sort: sortSpec(name).sort,
  });
  return [
    // ---- search (listings) ----
    q(
      "search.relevance",
      "Listing",
      "search",
      "services/search.js sortSpec",
      search("relevance").filter,
      { sort: search("relevance").sort, noSort: true },
    ),
    q(
      "search.rating",
      "Listing",
      "search",
      "services/search.js sortSpec",
      search("rating").filter,
      { sort: search("rating").sort, noSort: true },
    ),
    q(
      "search.newest",
      "Listing",
      "search",
      "services/search.js sortSpec",
      search("newest").filter,
      { sort: search("newest").sort, noSort: true },
    ),
    q(
      "search.price_asc",
      "Listing",
      "search",
      "services/search.js sortSpec",
      search("price_asc").filter,
      { sort: search("price_asc").sort, noSort: true },
    ),
    q(
      "search.price_desc",
      "Listing",
      "search",
      "services/search.js sortSpec",
      search("price_desc").filter,
      { sort: search("price_desc").sort, noSort: true },
    ),
    q(
      "search.count",
      "Listing",
      "search",
      "controllers/search.js countDocuments",
      published,
    ),
    q(
      "search.city_price",
      "Listing",
      "search",
      "services/search.js (destination + price sort)",
      {
        ...published,
        cityKey: "goa",
        "pricing.nightlyMinor": { $gte: 100000, $lte: 500000 },
      },
      { sort: sortSpec("price_asc").sort, bounded: "one city's listings" },
    ),
    q(
      "search.city_rating",
      "Listing",
      "search",
      "services/search.js (destination + default sort)",
      { ...published, cityKey: "goa" },
      { sort: sortSpec("relevance").sort, bounded: "one city's listings" },
    ),
    q(
      "search.country",
      "Listing",
      "search",
      "services/search.js (country)",
      { ...published, countryKey: "india" },
      { sort: sortSpec("newest").sort, bounded: "one country's listings" },
    ),
    q(
      "search.text",
      "Listing",
      "search",
      "services/search.js (keywords)",
      { ...published, $text: { $search: "beach" } },
      { sort: {}, bounded: "text matches" },
    ),
    q(
      "search.with_dates",
      "Listing",
      "search",
      "services/listingFilter.js (taken ids excluded)",
      { ...published, _id: { $nin: [ID] } },
      { sort: sortSpec("rating").sort, noSort: true },
    ),
    q(
      "search.map_anywhere",
      "Listing",
      "search",
      "services/mapSearch.js (no box)",
      { ...published, "publicGeometry.type": "Point" },
      { sort: { _id: -1 }, noSort: true },
    ),
    q(
      "search.map_box",
      "Listing",
      "search",
      "services/mapSearch.js (bounding box)",
      {
        ...published,
        "publicGeometry.type": "Point",
        publicGeometry: {
          $geoWithin: {
            $box: [
              [0, 0],
              [1, 1],
            ],
          },
        },
      },
      { sort: { _id: -1 }, bounded: "listings inside the box" },
    ),
    q("home.newest", "Listing", "search", "services/home.js", published, {
      sort: { _id: -1 },
      noSort: true,
    }),
    // ---- availability (night ledger) ----
    q(
      "availability.listing_range",
      "StayNight",
      "availability",
      "services/ledger.js (calendar, quote, ranges)",
      { listing: ID, date: { $gte: DAY, $lt: LATER } },
      { noSort: true },
    ),
    q(
      "availability.all_listings_range",
      "StayNight",
      "availability",
      "services/ledger.js unavailableListingIds (search with dates)",
      { date: { $gte: DAY, $lt: LATER } },
      {
        noSort: true,
        covered: true,
        project: { _id: 0, listing: 1, holdExpiresAt: 1 },
      },
    ),
    q(
      "availability.flexible_range",
      "StayNight",
      "availability",
      "services/ledger.js unavailableListingIdsFlexible",
      { date: { $gte: DAY, $lt: LATER } },
      {
        noSort: true,
        covered: true,
        project: { _id: 0, listing: 1, date: 1, holdExpiresAt: 1 },
      },
    ),
    q(
      "availability.by_source",
      "StayNight",
      "availability",
      "services/ledger.js releaseNights / confirmNights",
      { "source.id": ID },
    ),
    q(
      "availability.upcoming",
      "StayNight",
      "availability",
      "services/ledger.js hasUpcomingReservation",
      { listing: ID, "source.kind": "reservation", date: { $gte: DAY } },
    ),
    q(
      "availability.blocks",
      "AvailabilityBlock",
      "availability",
      "services/availability.js",
      { listing: ID, from: { $lt: LATER } },
    ),
    // ---- host lists ----
    q(
      "host.listings",
      "Listing",
      "host",
      "services/hostListings.js",
      { owner: ID, deletedAt: null },
      { sort: { updatedAt: -1, _id: -1 }, bounded: "one host's listings" },
    ),
    q(
      "host.calendar_listings",
      "Listing",
      "host",
      "services/hostCalendar.js",
      {
        owner: ID,
        deletedAt: null,
        status: { $in: ["published", "unpublished"] },
      },
      {
        sort: { title: 1, _id: 1 },
        bounded: "one host's listings (at most 50)",
      },
    ),
    q("host.profile_count", "Listing", "host", "services/profile.js", {
      owner: ID,
      ...published,
    }),
    q("host.calendar_nights", "StayNight", "host", "services/hostCalendar.js", {
      listing: { $in: [ID, OTHER] },
      date: { $gte: DAY, $lt: LATER },
    }),
    // ---- inbox and trips (reservations) ----
    q(
      "inbox.pending",
      "Reservation",
      "inbox",
      "services/hostInbox.js inboxQueries",
      inbox.pending.filter,
      { sort: inbox.pending.sort, noSort: true },
    ),
    q(
      "inbox.confirmed",
      "Reservation",
      "inbox",
      "services/hostInbox.js inboxQueries",
      inbox.confirmed.filter,
      { sort: inbox.confirmed.sort, noSort: true },
    ),
    q(
      "inbox.previous_stays",
      "Reservation",
      "inbox",
      "services/hostInbox.js (aggregate $match, mirrors)",
      { host: ID, status: "completed", guest: { $in: [ID, OTHER] } },
    ),
    ...Object.entries(tabs).map(([key, spec]) =>
      q(
        `trips.${key}`,
        "Reservation",
        "trips",
        "services/trips.js tabQuery",
        spec.filter,
        { sort: spec.sort, bounded: "one guest's bookings" },
      ),
    ),
    q(
      "reservations.idempotency",
      "Reservation",
      "trips",
      "services/reservations.js",
      { guest: ID, idempotencyKey: "a1b2c3d4e5f6" },
    ),
    q(
      "reservations.sweeper_expire",
      "Reservation",
      "sweeper",
      "services/sweeper.js (mirrors)",
      { status: "pending", holdExpiresAt: { $lt: NOW } },
      {
        sort: { _id: 1 },
        bounded: "requests past their hold (the backlog of one minute)",
      },
    ),
    q(
      "reservations.sweeper_complete",
      "Reservation",
      "sweeper",
      "services/sweeper.js (mirrors)",
      { status: "confirmed", checkOut: { $lte: DAY } },
      {
        sort: { _id: 1 },
        bounded: "stays that ended and are not yet completed",
      },
    ),
    q(
      "reviews.eligible",
      "Reservation",
      "reviews",
      "services/reviews.js findReviewable",
      { guest: ID, listing: OTHER, status: "completed" },
      { sort: { checkOut: -1 }, bounded: "one guest's stays" },
    ),
    // ---- reviews ----
    q(
      "reviews.by_listing",
      "Review",
      "reviews",
      "services/ratings.js",
      { listing: ID },
      { sort: { createdAt: -1 }, noSort: true },
    ),
    q(
      "reviews.by_author",
      "Review",
      "reviews",
      "services/profile.js",
      { author: ID },
      { sort: { createdAt: -1 }, noSort: true },
    ),
    q("reviews.by_reservation", "Review", "reviews", "services/trips.js", {
      reservation: { $in: [ID, OTHER] },
    }),
    // ---- reports, moderation, audit (admin) ----
    q(
      "reports.queue",
      "Report",
      "admin",
      "services/listingModeration.js",
      { targetKind: "listing", status: "open" },
      { sort: { createdAt: -1 }, bounded: "open reports" },
    ),
    q(
      "reports.by_status",
      "Report",
      "admin",
      "models/report.js (the queue)",
      { status: "open" },
      { sort: { createdAt: -1 }, noSort: true },
    ),
    q(
      "reports.mine",
      "Report",
      "admin",
      "services/reports.js",
      { reporter: ID },
      { sort: { createdAt: -1, _id: -1 }, bounded: "one member's reports" },
    ),
    q("reports.daily_cap", "Report", "admin", "services/reports.js", {
      reporter: ID,
      createdAt: { $gte: DAY },
    }),
    q(
      "moderation.new",
      "Listing",
      "admin",
      "services/listingModeration.js",
      { status: "published", deletedAt: null, "moderation.reviewedAt": null },
      {
        sort: { createdAt: 1, _id: 1 },
        bounded: "published listings not yet reviewed",
      },
    ),
    q(
      "moderation.suspended",
      "Listing",
      "admin",
      "services/listingModeration.js",
      { status: "suspended", deletedAt: null },
      { sort: { updatedAt: -1, _id: -1 }, bounded: "suspended listings" },
    ),
    q("drafts.stale", "Listing", "admin", "services/drafts.js", {
      status: "draft",
      updatedAt: { $lt: DAY },
    }),
    q(
      "audit.latest",
      "AuditLog",
      "admin",
      "services/audit.js",
      {},
      { sort: { createdAt: -1, _id: -1 }, noSort: true },
    ),
    q(
      "audit.by_target",
      "AuditLog",
      "admin",
      "services/userAdmin.js / listingModeration.js",
      { targetType: "listing", targetId: ID },
      {
        sort: { createdAt: -1, _id: -1 },
        bounded: "one listing's or member's admin history (shown 10 at a time)",
      },
    ),
    q("users.by_username", "User", "admin", "passport (login)", {
      username: "ravi",
    }),
    q(
      "users.admin_search",
      "User",
      "admin",
      "services/userAdmin.js searchUsers",
      { $or: [{ username: /ra/i }, { email: /ra/i }, { displayName: /ra/i }] },
      {
        sort: { username: 1, _id: 1 },
        scan: "admin-only substring search over the users collection (a regular expression cannot use an index for a 'contains' match)",
      },
    ),
  ];
}

const MODELS = {
  Listing: () => require("../models/listing"),
  Reservation: () => require("../models/reservation"),
  StayNight: () => require("../models/stayNight"),
  AvailabilityBlock: () => require("../models/availabilityBlock"),
  Review: () => require("../models/review"),
  Report: () => require("../models/report"),
  AuditLog: () => require("../models/auditLog"),
  User: () => require("../models/user"),
};

/** The model class for a query's collection. */
const modelFor = (query) => MODELS[query.model]();

/** Every hot query with the checker's verdict against the declared indexes. */
function reviewQueries(queries = hotQueries()) {
  const cache = new Map();
  return queries.map((query) => {
    if (!cache.has(query.model))
      cache.set(query.model, declaredIndexes(modelFor(query)));
    const verdict = analyse(query, cache.get(query.model));
    return {
      ...query,
      ...verdict,
      indexes: cache.get(query.model).map((i) => i.name),
    };
  });
}

// ---- MongoDB's own account (explain) -----------------------------------------

/** Every stage of a plan, depth first, as { stage, indexName? }. */
function planStages(plan, out = []) {
  if (!plan || typeof plan !== "object") return out;
  out.push({
    stage: plan.stage,
    ...(plan.indexName ? { indexName: plan.indexName } : {}),
  });
  for (const key of ["inputStage", "outerStage", "innerStage"])
    planStages(plan[key], out);
  if (Array.isArray(plan.inputStages))
    plan.inputStages.forEach((s) => planStages(s, out));
  if (plan.shards) plan.shards.forEach((s) => planStages(s.winningPlan, out));
  return out;
}

/**
 * Runs `explain("executionStats")` for one query on the connected database and
 * summarises it.
 * @returns {Promise<{ stages: string[], indexes: string[], collscan: boolean,
 *   sortInMemory: boolean, fetch: boolean, keysExamined: number,
 *   docsExamined: number, returned: number, millis: number }>}
 */
async function runExplain(query, { limit = 0 } = {}) {
  const Model = modelFor(query);
  let cursor = Model.find(query.filter, query.project || undefined);
  if (query.sort && Object.keys(query.sort).length)
    cursor = cursor.sort(query.sort);
  if (limit) cursor = cursor.limit(limit);
  const report = await cursor.explain("executionStats");
  const stats = report.executionStats || {};
  const stages = planStages((report.queryPlanner || {}).winningPlan).map(
    (s) => s.stage,
  );
  const indexes = planStages((report.queryPlanner || {}).winningPlan)
    .filter((s) => s.indexName)
    .map((s) => s.indexName);
  return {
    stages,
    indexes: [...new Set(indexes)],
    collscan: stages.includes("COLLSCAN"),
    sortInMemory: stages.includes("SORT"),
    fetch: stages.includes("FETCH"),
    keysExamined: stats.totalKeysExamined || 0,
    docsExamined: stats.totalDocsExamined || 0,
    returned: stats.nReturned || 0,
    millis: stats.executionTimeMillis || 0,
  };
}

/**
 * What a measured plan breaks, given what the query promises:
 * a collection scan (unless the query says why it is accepted), an in-memory
 * sort where the query promises none, a document fetch where it promises an
 * index-only answer.
 */
function violations(query, measured) {
  const found = [];
  if (measured.collscan && !query.scan) found.push("collection scan");
  if (measured.sortInMemory && query.noSort) found.push("in-memory sort");
  if (query.covered && (measured.fetch || measured.docsExamined > 0))
    found.push("reads documents (not index-only)");
  return found;
}

module.exports = {
  analyse,
  constraints,
  classify,
  deliversSort,
  declaredIndexes,
  autoName,
  hotQueries,
  reviewQueries,
  modelFor,
  planStages,
  runExplain,
  violations,
};
