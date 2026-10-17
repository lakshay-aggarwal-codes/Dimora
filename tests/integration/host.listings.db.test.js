// P04-T06 through the real routes: the "My listings" page. Needs a MongoDB
// (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");

const photos = () =>
  [1, 2, 3, 4, 5].map((n) => ({
    url: `https://res.cloudinary.test/dimora_DEV/my${n}.jpg`,
    publicId: `dimora_DEV/my${n}`,
    alt: "",
    caption: "",
    order: n - 1,
  }));
const READY = () => ({
  images: photos(),
  description: "A bright, quiet flat close to the beach with everything you need. ".repeat(4),
  address: { line1: "12 Beach Road", city: "Goa", country: "India" },
  needsReview: false,
  houseRules: "No smoking.",
});

async function signedIn() {
  const { user, password } = await createUser();
  const agent = await login(createAgent(), { username: user.username, password });
  return { agent, user };
}

describeDb("My listings", () => {
  useTestDb();

  test("anonymous visitors are sent to /login", async () => {
    const res = await createAgent().get("/host/listings");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  test("a host with no listings sees an invitation to make the first one", async () => {
    const { agent } = await signedIn();
    const res = await agent.get("/host/listings");
    expect(res.status).toBe(200);
    expect(res.text).toContain("You have no listings yet");
    expect(res.text).toContain('href="/host/listings/new"');
    expect(res.text).not.toContain("<table");
  });

  test("it lists only this host's listings, never deleted ones, never someone else's", async () => {
    const { agent, user } = await signedIn();
    const { user: other } = await createUser();
    await createListing({ owner: user._id, title: "Mine one" });
    await createListing({ owner: user._id, title: "Mine deleted", deletedAt: new Date() });
    await createListing({ owner: other._id, title: "Theirs" });
    const res = await agent.get("/host/listings");
    expect(res.text).toContain("Mine one");
    expect(res.text).not.toContain("Mine deleted");
    expect(res.text).not.toContain("Theirs");
  });

  test("each row shows status in words, readiness, date and the right actions", async () => {
    const { agent, user } = await signedIn();
    const published = await createListing({ owner: user._id, title: "Live flat", ...READY() });
    const draft = await createListing({ owner: user._id, title: "Half done", status: "draft" });
    const ready = await createListing({
      owner: user._id,
      title: "Ready but off",
      status: "unpublished",
      ...READY(),
    });
    const notReady = await createListing({
      owner: user._id,
      title: "Off and short",
      status: "unpublished",
    });
    const res = await agent.get("/host/listings");
    expect(res.status).toBe(200);
    for (const word of ["Published", "Draft", "Unpublished"]) expect(res.text).toContain(word);
    expect(res.text).toContain("Everything is done");
    expect(res.text).toMatch(/\d+ items? to do/);
    expect(res.text).toMatch(/<time datetime="\d{4}-\d\d-\d\dT/);
    expect(res.text).toContain(`href="/listings/${published._id}"`);
    expect(res.text).toContain(`action="/host/listings/${published._id}/unpublish"`);
    expect(res.text).toContain(`href="/host/listings/${draft._id}"`);
    expect(res.text).toContain(`action="/host/listings/${ready._id}/publish"`);
    expect(res.text).not.toContain(`action="/host/listings/${notReady._id}/publish"`);
    expect(res.text).toContain(`href="/host/listings/${notReady._id}/status"`);
  });

  test("the unpublish and publish buttons really work from the list", async () => {
    const { agent, user } = await signedIn();
    const live = await createListing({ owner: user._id, ...READY() });
    const res = await agent.post(`/host/listings/${live._id}/unpublish`);
    expect(res.status).toBe(302);
    expect((await Listing.findById(live._id)).status).toBe("unpublished");
    const page = await agent.get("/host/listings");
    expect(page.text).toContain(`action="/host/listings/${live._id}/publish"`);
  });

  test("the most recently changed listing comes first", async () => {
    const { agent, user } = await signedIn();
    const older = await createListing({ owner: user._id, title: "Older listing" });
    const newer = await createListing({ owner: user._id, title: "Newer listing" });
    await Listing.collection.updateOne(
      { _id: older._id },
      { $set: { updatedAt: new Date("2020-01-01T00:00:00Z") } },
    );
    await Listing.collection.updateOne(
      { _id: newer._id },
      { $set: { updatedAt: new Date("2021-01-01T00:00:00Z") } },
    );
    const { text } = await agent.get("/host/listings");
    expect(text.indexOf("Newer listing")).toBeLessThan(text.indexOf("Older listing"));
  });

  test("titles are escaped and the page is a table with a caption and column headings", async () => {
    const { agent, user } = await signedIn();
    await createListing({ owner: user._id, title: "<script>alert(1)</script>" });
    const { text } = await agent.get("/host/listings");
    expect(text).not.toContain("<script>alert(1)");
    expect(text).toContain("&lt;script&gt;alert(1)");
    expect(text).toContain("<caption");
    expect(text).toMatch(/<th scope="col">Status<\/th>/);
    expect(text).not.toMatch(/style="/);
  });

  test("the account menu links to it", async () => {
    const { agent } = await signedIn();
    const res = await agent.get("/host/listings");
    expect(res.text).toContain('<a class="dropdown-item" href="/host/listings">My listings</a>');
  });

  test("a listing nobody else can see (a draft) is still listed for its host", async () => {
    const { agent, user } = await signedIn();
    await createListing({ owner: user._id, title: "Secret draft", status: "draft" });
    expect((await agent.get("/host/listings")).text).toContain("Secret draft");
    expect((await createAgent().get("/listings")).text).not.toContain("Secret draft");
  });
});
