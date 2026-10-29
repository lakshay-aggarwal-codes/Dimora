// P15-T06: the purpose rules and the ranking, with fake models (no database).
const assert = require("node:assert/strict");
const { PURPOSES, PURPOSE_SLUGS, getPurpose } = require("../../src/config/purposes");
const { AMENITY_VALUES, ROOM_TYPE_VALUES } = require("../../src/config/constants");
const { scoreListing, maxScore, rankedPage, MAX_RANKED } = require("../../src/services/purposeRank");

const KINDS = ["amenity", "roomType", "minBedrooms", "minGuests", "instantBook"];

test("the three purposes exist with explicit, small, valid rules", () => {
  assert.deepEqual(PURPOSE_SLUGS, ["work", "family", "weekend"]);
  for (const p of PURPOSES) {
    assert.ok(p.label && p.summary, p.slug);
    assert.ok(p.rules.length >= 3, p.slug);
    for (const rule of p.rules) {
      assert.ok(rule.label, p.slug);
      assert.ok(Number.isInteger(rule.points) && rule.points >= 1 && rule.points <= 3, `${p.slug}: ${rule.label}`);
      assert.ok(KINDS.includes(rule.kind), rule.kind);
      if (rule.kind === "amenity") assert.ok(AMENITY_VALUES.includes(rule.value), rule.value);
      if (rule.kind === "roomType") assert.ok(ROOM_TYPE_VALUES.includes(rule.value), rule.value);
      if (rule.kind === "minBedrooms" || rule.kind === "minGuests") assert.ok(Number.isInteger(rule.value) && rule.value > 0);
    }
  }
});

test("the rules cannot be changed at run time", () => {
  assert.throws(() => { "use strict"; PURPOSES.push({}); });
  assert.throws(() => { "use strict"; PURPOSES[0].rules[0].points = 99; });
});

test("getPurpose answers only for the known slugs", () => {
  assert.equal(getPurpose("work").slug, "work");
  for (const bad of ["", "Work", "constructor", "__proto__", undefined, null, 1, ["work"], {}]) assert.equal(getPurpose(bad), null);
});

const work = getPurpose("work");
const family = getPurpose("family");
const weekend = getPurpose("weekend");

test("work: wifi and a workspace count most", () => {
  assert.equal(scoreListing(work, { amenities: ["wifi", "workspace"] }).score, 6);
  assert.equal(scoreListing(work, { amenities: ["wifi"] }).score, 3);
  assert.equal(scoreListing(work, { amenities: ["pool", "tv"] }).score, 0);
  assert.equal(scoreListing(work, { amenities: ["wifi", "workspace", "air_conditioning"], roomType: "entire_place" }).score, maxScore(work));
});

test("family: bedrooms and guests are thresholds, not counts", () => {
  assert.equal(scoreListing(family, { capacity: { bedrooms: 1, guests: 3 } }).score, 0);
  assert.equal(scoreListing(family, { capacity: { bedrooms: 2, guests: 3 } }).score, 3);
  assert.equal(scoreListing(family, { capacity: { bedrooms: 5, guests: 8 } }).score, 5);
  assert.equal(scoreListing(family, { capacity: { bedrooms: 2, guests: 4 }, amenities: ["kitchen"], roomType: "entire_place" }).score, 9);
});

test("weekend: instant book only counts when it is exactly true", () => {
  assert.equal(scoreListing(weekend, { instantBook: true }).score, 2);
  for (const v of [false, undefined, null, "true", 1]) assert.equal(scoreListing(weekend, { instantBook: v }).score, 0);
});

test("missing or odd fields score zero and never throw", () => {
  for (const l of [undefined, null, {}, { amenities: "wifi" }, { capacity: null }, { capacity: { bedrooms: "x" } }]) {
    for (const p of PURPOSES) assert.doesNotThrow(() => scoreListing(p, l));
  }
  assert.equal(scoreListing(work, {}).score, 0);
});

test("scoreListing says which rules matched", () => {
  const { matched } = scoreListing(work, { amenities: ["wifi"] });
  assert.deepEqual(matched.map((r) => r.label), ["Wi-Fi"]);
});

// ---- rankedPage ----
function fakeModel(rows, docsById = null) {
  const calls = { find: [] };
  const docs = docsById || new Map((rows || []).map((r) => [String(r._id), { _id: r._id, title: `L${r._id}` }]));
  return {
    calls,
    find(filter) {
      calls.find.push(filter);
      if (filter && filter._id && filter._id.$in) {
        return Promise.resolve(filter._id.$in.map((id) => docs.get(String(id))).filter(Boolean).reverse()); // DB order is not ours
      }
      const chain = {
        select: (s) => ((calls.select = s), chain),
        sort: (s) => ((calls.sort = s), chain),
        limit: (n) => ((calls.limit = n), chain),
        lean: async () => rows,
      };
      return chain;
    },
  };
}
const row = (id, over = {}) => ({ _id: id, amenities: [], ...over });

test("higher scores first; equal scores keep the normal order", async () => {
  const rows = [
    row(1), // 0, normal order first
    row(2, { amenities: ["wifi"] }), // 3
    row(3), // 0
    row(4, { amenities: ["wifi", "workspace"] }), // 6
    row(5, { amenities: ["wifi"] }), // 3
  ];
  const out = await rankedPage({ Listing: fakeModel(rows), filter: { status: "published" }, purpose: work, page: 1, pageSize: 10 });
  assert.deepEqual(out.map((d) => d._id), [4, 2, 5, 1, 3]);
});

test("pages are cut after ranking, not before", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(i + 1, i === 6 ? { amenities: ["wifi", "workspace"] } : {}));
  const page1 = await rankedPage({ Listing: fakeModel(rows), filter: {}, purpose: work, page: 1, pageSize: 3 });
  const page3 = await rankedPage({ Listing: fakeModel(rows), filter: {}, purpose: work, page: 3, pageSize: 3 });
  assert.deepEqual(page1.map((d) => d._id), [7, 1, 2]);
  assert.deepEqual(page3.map((d) => d._id), [6]);
  assert.deepEqual(await rankedPage({ Listing: fakeModel(rows), filter: {}, purpose: work, page: 9, pageSize: 3 }), []);
});

test("it asks for a small projection in the normal order, capped, with the caller's filter", async () => {
  const m = fakeModel([row(1)]);
  const filter = { status: "published", deletedAt: null };
  await rankedPage({ Listing: m, filter, purpose: family, page: 1, pageSize: 12 });
  assert.equal(m.calls.find[0], filter);
  assert.match(m.calls.select, /amenities/);
  assert.match(m.calls.select, /capacity/);
  assert.equal(m.calls.limit, MAX_RANKED);
  assert.deepEqual(m.calls.sort, { ratingAvg: -1, ratingCount: -1, _id: -1 });
});

test("a listing that disappears between the two queries is skipped, not an error", async () => {
  const rows = [row(1), row(2)];
  const docs = new Map([["1", { _id: 1 }]]);
  const out = await rankedPage({ Listing: fakeModel(rows, docs), filter: {}, purpose: work, page: 1, pageSize: 5 });
  assert.deepEqual(out.map((d) => d._id), [1]);
});

test("no matches, or an odd answer, gives an empty page", async () => {
  assert.deepEqual(await rankedPage({ Listing: fakeModel([]), filter: {}, purpose: work, page: 1, pageSize: 5 }), []);
  assert.deepEqual(await rankedPage({ Listing: fakeModel(undefined), filter: {}, purpose: work, page: 1, pageSize: 5 }), []);
});
