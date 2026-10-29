// P15-T06 against a real MongoDB and the real app: the trip-purpose ordering and
// the click-through counters. Needs a MongoDB; skipped with SKIP_DB_TESTS=1.
const assert = require("node:assert/strict");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const ListingStat = require("../../src/models/listingStat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pos = (text, title) => text.indexOf(title);

async function stay(owner, title, set = {}) {
  const l = await createListing({ owner });
  await Listing.updateOne({ _id: l._id }, { $set: { title, status: "published", deletedAt: null, ...set } });
  return l;
}

describeDb("trip purpose ranking (database)", () => {
  useTestDb();

  async function seed() {
    const { user } = await createUser();
    // Normal order is rating first: "Plain" is rated best, "Desk" worst.
    const plain = await stay(user, "Plain flat", { amenities: [], ratingAvg: 4.9, ratingCount: 10 });
    const wifi = await stay(user, "Wifi flat", { amenities: ["wifi"], ratingAvg: 4.5, ratingCount: 5 });
    const desk = await stay(user, "Desk flat", { amenities: ["wifi", "workspace"], ratingAvg: 3.0, ratingCount: 2 });
    return { plain, wifi, desk };
  }

  test("work puts the stays with wifi and a workspace first; without a purpose the rating order stays", async () => {
    await seed();
    const normal = (await createAgent().get("/listings")).text;
    assert.ok(pos(normal, "Plain flat") < pos(normal, "Wifi flat") && pos(normal, "Wifi flat") < pos(normal, "Desk flat"));
    const work = (await createAgent().get("/listings?purpose=work")).text;
    assert.ok(pos(work, "Desk flat") < pos(work, "Wifi flat") && pos(work, "Wifi flat") < pos(work, "Plain flat"));
  });

  test("it only re-orders: the same stays, the same count", async () => {
    await seed();
    const a = (await createAgent().get("/listings")).text;
    const b = (await createAgent().get("/listings?purpose=work")).text;
    for (const t of ["Plain flat", "Wifi flat", "Desk flat"]) assert.ok(a.includes(t) && b.includes(t), t);
  });

  test("the page lists the rules and links to the other purposes, keeping the search", async () => {
    await seed();
    const html = (await createAgent().get("/listings?purpose=work&guests=2")).text;
    assert.match(html, /data-purpose-rules/);
    assert.match(html, /\+3 Wi-Fi/);
    assert.match(html, /\+3 Dedicated workspace/);
    assert.match(html, /href="\/listings\?guests=2&amp;purpose=family"/);
    assert.match(html, /aria-current="true">Work trip/);
  });

  test("another sort order wins, and the page says the purpose is not acting", async () => {
    await seed();
    const html = (await createAgent().get("/listings?purpose=work&sort=newest")).text;
    assert.match(html, /data-purpose-off/);
    assert.match(html, /only applies to the Best match order/);
  });

  test("a search by words keeps its own relevance and says so", async () => {
    await seed();
    const html = (await createAgent().get("/listings?purpose=work&keywords=flat")).text;
    assert.match(html, /off while you search by words/);
  });

  test("an unknown purpose does not break the page", async () => {
    await seed();
    const res = await createAgent().get("/listings?purpose=luxury");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Plain flat"));
  });

  test("a results page counts what it showed, per ordering, and crawlers are not counted", async () => {
    const { plain } = await seed();
    await createAgent().get("/listings");
    await createAgent().get("/listings?purpose=work");
    await createAgent().get("/listings?sort=price_asc");
    await createAgent().get("/listings").set("User-Agent", "Googlebot/2.1");
    await sleep(300);
    const stat = await ListingStat.findOne({ listing: plain._id }).lean();
    assert.equal(stat.ranking.default.shown, 1);
    assert.equal(stat.ranking.work.shown, 1);
    assert.equal(stat.ranking.family.shown, 0);
  });

  test("opening a stay from the results counts one click per session; a wrong value counts none", async () => {
    const { plain } = await seed();
    const agent = createAgent();
    await agent.get(`/listings/${plain._id}?from=work`);
    await agent.get(`/listings/${plain._id}?from=work`);
    await createAgent().get(`/listings/${plain._id}?from=price_asc`);
    await createAgent().get(`/listings/${plain._id}?from[]=work`);
    await createAgent().get(`/listings/${plain._id}`);
    await sleep(300);
    const stat = await ListingStat.findOne({ listing: plain._id }).lean();
    assert.equal(stat.ranking.work.clicked, 1);
    assert.equal(stat.ranking.default.clicked, 0);
  });

  test("the cards on a Best-match page carry the ordering in their links", async () => {
    await seed();
    assert.match((await createAgent().get("/listings?purpose=family")).text, /href="\/listings\/[0-9a-f]{24}\?from=family"/);
    assert.match((await createAgent().get("/listings")).text, /\?from=default"/);
    assert.equal(/\?from=/.test((await createAgent().get("/listings?sort=newest")).text.replace(/href="\/listings\?[^"]*"/g, "")), false);
  });
});
