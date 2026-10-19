// P01-T06: detail page against a real database (see tests/helpers/db.js):
// owner populated, owner deleted, owner-only buttons.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const User = require("../../src/models/user");

async function loggedIn(agentUser) {
  const { user, password } = agentUser || (await createUser());
  const agent = await login(createAgent(), { username: user.username, password });
  return { agent, user };
}

describeDb("listing detail page (database)", () => {
  useTestDb();

  test("shows the owner's name and the map for a normal listing", async () => {
    const { user: owner } = await createUser();
    const listing = await createListing({ owner, title: "Hill Cabin" });
    const res = await createAgent().get(`/listings/${listing._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Hill Cabin");
    expect(res.text).toContain(owner.username);
    expect(res.text).toMatch(/data-lng="-?\d+\.\d+"/);
    expect(res.text).not.toContain('data-lng="77.209"'); // the approximate point (P06-T02)
  });

  test("regression D-05: an owner id that points at no user renders without a 500", async () => {
    const listing = await createListing({
      owner: new mongoose.Types.ObjectId(),
      title: "Orphaned Villa",
    });
    const res = await createAgent().get(`/listings/${listing._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Orphaned Villa");
    expect(res.text).not.toContain("Hosted by");

    // Logged in, the owner check (owner._id.equals) must not crash either.
    const { agent } = await loggedIn();
    expect((await agent.get(`/listings/${listing._id}`)).status).toBe(200);
  });

  test("an owner whose account was deleted renders without a 500", async () => {
    const { user: owner } = await createUser();
    const listing = await createListing({ owner, title: "Left Behind Loft" });
    await User.deleteOne({ _id: owner._id });
    const res = await createAgent().get(`/listings/${listing._id}`);
    expect(res.status).toBe(200);
  });

  test("a legacy listing stored without geometry or price still renders", async () => {
    const { user: owner } = await createUser();
    const _id = new mongoose.Types.ObjectId();
    // Bypass Mongoose validation, as old documents were written without it.
    await Listing.collection.insertOne({
      _id,
      title: "Legacy Home",
      owner: owner._id,
      reviews: [],
    });
    const res = await createAgent().get(`/listings/${_id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Legacy Home");
    expect(res.text).toContain("Price not available");
    expect(res.text).toContain("The map is not available for this listing yet.");
  });

  test("only the owner sees Edit and Delete", async () => {
    const { user: owner, password } = await createUser();
    const listing = await createListing({ owner });
    const url = `/listings/${listing._id}`;

    const ownerView = await (await loggedIn({ user: owner, password })).agent.get(url);
    expect(ownerView.text).toContain(`${url}/edit`);
    expect(ownerView.text).toContain("Delete");

    const otherView = await (await loggedIn()).agent.get(url);
    expect(otherView.status).toBe(200);
    expect(otherView.text).not.toContain(`${url}/edit`);

    const anonymousView = await createAgent().get(url);
    expect(anonymousView.text).not.toContain(`${url}/edit`);
  });
});
