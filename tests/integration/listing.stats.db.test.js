// P13-T03 against a real MongoDB: views are counted once per session per day,
// the host sees them on /host/listings/:id/stats, saves never go below zero.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const DayStat = require("../../src/models/listingDayStat");
const ListingStat = require("../../src/models/listingStat");
const WishlistItem = require("../../src/models/wishlistItem");
const wishlists = require("../../src/services/wishlists");

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const views = async (listing) =>
  (await DayStat.find({ listing: listing._id }).lean()).reduce((n, r) => n + r.views, 0);

async function signedIn(overrides) {
  const { user, password } = await createUser(overrides);
  return { user, agent: await login(createAgent(), { username: user.username, password }) };
}
const open = (agent, listing, ua = CHROME) => agent.get(`/listings/${listing._id}`).set("User-Agent", ua);

describeDb("listing statistics (database)", () => {
  useTestDb();

  test("a page view counts once per session per day; another session counts again", async () => {
    const { user: host } = await createUser();
    const listing = await createListing({ owner: host, status: "published" });
    const a = createAgent();
    expect((await open(a, listing)).status).toBe(200);
    await open(a, listing);
    await open(a, listing);
    expect(await views(listing)).toBe(1);
    await open(createAgent(), listing);
    expect(await views(listing)).toBe(2);
  });

  test("bots, the host, a preview and a page that is not public are not counted", async () => {
    const { user: host, password } = await createUser();
    const listing = await createListing({ owner: host, status: "published" });
    await open(createAgent(), listing, "Googlebot/2.1 (+http://www.google.com/bot.html)");
    await open(createAgent(), listing, "curl/8.4.0");
    const hostAgent = await login(createAgent(), { username: host.username, password });
    await open(hostAgent, listing);
    await hostAgent.get(`/listings/${listing._id}?preview=1`).set("User-Agent", CHROME);
    const draft = await createListing({ owner: host, status: "draft" });
    await open(createAgent(), draft);
    expect(await views(listing)).toBe(0);
    expect(await views(draft)).toBe(0);
  });

  test("the host's statistics page shows the counts, escaped, and says the numbers are approximate", async () => {
    const { user: host, password } = await createUser();
    const listing = await createListing({ owner: host, status: "published", title: "Sea <b>house</b>" });
    for (let i = 0; i < 3; i += 1) await open(createAgent(), listing);
    const agent = await login(createAgent(), { username: host.username, password });
    const res = await agent.get(`/host/listings/${listing._id}/stats`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.text).toMatch(/approximate/);
    expect(res.text).toMatch(/<p class="h3 mb-0">3<\/p><p class="mb-0 small">Views/);
    expect(res.text).toContain("<svg");
    expect(res.text).toContain("Sea &lt;b&gt;house&lt;/b&gt;");
    expect(res.text).not.toContain("Sea <b>house</b>");
    expect(res.text).toMatch(/at least 30 views/); // conversion hidden below 30
  });

  test("with no views the page says so and draws no chart", async () => {
    const { user: host, password } = await createUser();
    const listing = await createListing({ owner: host, status: "published" });
    const agent = await login(createAgent(), { username: host.username, password });
    const res = await agent.get(`/host/listings/${listing._id}/stats`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/No views counted yet/);
    expect(res.text).not.toContain("<svg class=\"stat-spark\"");
  });

  test("only the listing's host can open it", async () => {
    const { user: host } = await createUser();
    const listing = await createListing({ owner: host, status: "published" });
    const { agent: stranger } = await signedIn();
    expect([403, 404]).toContain((await stranger.get(`/host/listings/${listing._id}/stats`)).status);
    const anon = await createAgent().get(`/host/listings/${listing._id}/stats`);
    expect([302, 401, 403, 404]).toContain(anon.status);
    expect(anon.text).not.toContain("Views and saves");
  });

  test("a save adds to the day's saves; removing it lowers the lifetime figure but not the day", async () => {
    const { user: host } = await createUser();
    const { user: guest } = await createUser();
    const listing = await createListing({ owner: host, status: "published" });
    await wishlists.setSaved(guest._id, listing._id, true);
    let day = await DayStat.findOne({ listing: listing._id }).lean();
    expect(day.saves).toBe(1);
    expect((await ListingStat.findOne({ listing: listing._id })).saves).toBe(1);
    await wishlists.setSaved(guest._id, listing._id, false);
    day = await DayStat.findOne({ listing: listing._id }).lean();
    expect(day.saves).toBe(1);
    expect((await ListingStat.findOne({ listing: listing._id })).saves).toBe(0);
  });

  test("the lifetime saves never go below zero, even when the counter was missing", async () => {
    const { user: host } = await createUser();
    const { user: guest } = await createUser();
    const listing = await createListing({ owner: host, status: "published" });
    await wishlists.setSaved(guest._id, listing._id, true);
    await ListingStat.deleteMany({ listing: listing._id }); // as if saved before counting existed
    await wishlists.setSaved(guest._id, listing._id, false);
    expect((await ListingStat.findOne({ listing: listing._id })).saves).toBe(0);
    expect(await WishlistItem.countDocuments({ listing: listing._id })).toBe(0);
  });

  test("saving twice, or removing what was never saved, changes no counter", async () => {
    const { user: host } = await createUser();
    const { user: guest } = await createUser();
    const listing = await createListing({ owner: host, status: "published" });
    await wishlists.setSaved(guest._id, listing._id, true);
    await wishlists.setSaved(guest._id, listing._id, true);
    await wishlists.setSaved(guest._id, listing._id, false);
    await wishlists.setSaved(guest._id, listing._id, false);
    expect((await DayStat.findOne({ listing: listing._id }).lean()).saves).toBe(1);
    expect((await ListingStat.findOne({ listing: listing._id })).saves).toBe(0);
  });
});
