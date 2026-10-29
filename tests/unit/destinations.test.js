// P05-T06: destination suggestions, with a fake model (no database).
const assert = require("node:assert/strict");
const { conditionFor, present, suggestDestinations, MAX_SUGGESTIONS } = require("../../src/services/destinations");

function fakeListing(groups) {
  const calls = [];
  return { calls, aggregate: async (pipeline) => (calls.push(pipeline), groups) };
}
const group = (keys, extra = {}) => ({
  _id: { cityKey: keys[0] || "", stateKey: keys[1] || "", countryKey: keys[2] || "" },
  count: 1,
  ...extra,
});

test("fewer than two letters, empty, repeated or odd input never reaches the database", async () => {
  const m = fakeListing([]);
  for (const q of ["", " ", "p", " p ", ",", "a,", undefined, null, 42, ["pan"], { a: 1 }]) {
    assert.deepEqual(await suggestDestinations({ Listing: m, q }), []);
  }
  assert.equal(m.calls.length, 0);
});

test("one word matches the start of a city or a country", () => {
  const c = conditionFor("Pan");
  assert.equal(c.$or.length, 2);
  assert.ok(c.$or[0].cityKey.test("panaji") && !c.$or[0].cityKey.test("japan"));
  assert.ok(c.$or[1].countryKey.test("panama") && !c.$or[1].countryKey.test("japan"));
});

test("accents and capitals do not matter: 'SÃO pa' finds 'sao paulo'", () => {
  assert.ok(conditionFor("SÃO pa").$or[0].cityKey.test("sao paulo"));
});

test("'city, state' and 'city, state, country' narrow the match", () => {
  const two = conditionFor("panaji, g");
  assert.ok(two.cityKey.test("panaji") && two.stateKey.test("goa") && !two.stateKey.test("kerala"));
  assert.equal(two.countryKey, undefined);
  const three = conditionFor("panaji, goa, in");
  assert.ok(three.countryKey.test("india"));
});

test("punctuation and regex characters are removed before matching", () => {
  assert.equal(conditionFor(".*"), null);
  assert.equal(conditionFor("[[[]]]((((**"), null);
  assert.equal(conditionFor("a(b").$or[0].cityKey.source, "^a b");
  assert.equal(conditionFor("pa.*").$or[0].cityKey.test("pxyz"), false);
});

test("the pipeline matches only public stays, groups, sorts, and is capped", async () => {
  const m = fakeListing([]);
  await suggestDestinations({ Listing: m, q: "pan", limit: 500 });
  const [match, groupStage, sort, limit] = m.calls[0];
  assert.equal(match.$match.status, "published");
  assert.equal(match.$match.deletedAt, null);
  assert.ok(match.$match.$or);
  assert.ok(groupStage.$group);
  assert.deepEqual(sort.$sort.count, -1);
  assert.equal(limit.$limit, MAX_SUGGESTIONS);
});

test("a suggestion shows the host's wording and searches with it", () => {
  const out = present(group(["panaji", "goa", "india"], { count: 3, city: "Panaji", state: "Goa", country: "India" }));
  assert.deepEqual(out, { label: "Panaji, Goa, India", dest: "Panaji, Goa, India", count: 3 });
});

test("accented wording is kept when it normalises to the stored keys", () => {
  const out = present(group(["sao paulo", "", "brazil"], { city: "São Paulo", country: "Brazil" }));
  assert.equal(out.dest, "São Paulo, Brazil");
});

test("wording that would not find its own stays falls back to the stored keys", () => {
  const out = present(group(["panaji", "goa", "india"], { city: "Panjim (Panaji)", state: "Goa", country: "India" }));
  assert.equal(out.dest, "panaji, goa, india");
  assert.equal(out.label, out.dest);
});

test("an old listing with only a free-text location is shown by its first part", () => {
  const out = present(group(["panaji", "goa"], { location: "Panaji, Goa", state: "Goa" }));
  assert.equal(out.dest, "Panaji, Goa");
});

test("duplicates and rows without a city are dropped; order is kept", async () => {
  const m = fakeListing([
    group(["goa city", "goa", "india"], { count: 5, city: "Goa City", state: "Goa", country: "India" }),
    group(["goa city", "goa", "india"], { count: 1, city: "Goa City", state: "Goa", country: "India" }),
    group(["", "goa", "india"], { count: 4 }),
    null,
    group(["goalpara", "assam", "india"], { count: 2, city: "Goalpara", state: "Assam", country: "India" }),
  ]);
  const out = await suggestDestinations({ Listing: m, q: "goa" });
  assert.deepEqual(out.map((o) => o.dest), ["Goa City, Goa, India", "Goalpara, Assam, India"]);
  assert.equal(out[0].count, 5);
});

test("a database that returns something odd gives an empty list, not a crash", async () => {
  assert.deepEqual(await suggestDestinations({ Listing: fakeListing(undefined), q: "pan" }), []);
});
