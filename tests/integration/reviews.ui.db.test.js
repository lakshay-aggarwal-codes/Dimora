// P01-T07 (D-09, D-13 partial, D-08): navbar when logged in, the review form,
// review timestamps and the review delete button. Needs a MongoDB
// (see tests/helpers/db.js).
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing, createReview, createCompletedStay } = require("../helpers/factories");
const Review = require("../../src/models/review");

async function loggedIn() {
  const { user, password } = await createUser();
  const agent = await login(createAgent(), { username: user.username, password });
  return { agent, user };
}

describeDb("review form, timestamps and navbar (database)", () => {
  useTestDb();

  test("the navbar for a logged-in user shows Logout and no Sign Up", async () => {
    const { agent } = await loggedIn();
    const res = await agent.get("/listings");
    expect(res.text).toContain('action="/logout"');
    expect(res.text).not.toContain('href="/logout"');
    expect(res.text).toContain("Logout");
    expect(res.text).not.toContain("Login out");
    expect(res.text).not.toContain('href="/signup');
  });

  test("the review form (for a guest with a completed stay) has a required rating and nothing pre-selected", async () => {
    const listing = await createListing();
    const { agent, user } = await loggedIn();
    await createCompletedStay({ listing, guest: user });
    const res = await agent.get(`/listings/${listing._id}`);

    const radios = res.text.match(/<input type="radio"[^>]*>/g) || [];
    expect(radios).toHaveLength(5);
    for (const radio of radios) {
      expect(radio).toMatch(/\brequired\b/);
      expect(radio).not.toMatch(/\bchecked\b/);
    }
    expect(res.text).toContain('name="review[reservation]"');
    expect(res.text).not.toContain("no-rate");
  });

  test("a signed-in member with no stay sees no review form (P12-T01)", async () => {
    const listing = await createListing();
    const { agent } = await loggedIn();
    const res = await agent.get(`/listings/${listing._id}`);
    expect(res.text).not.toContain("Submit review");
    expect(res.text).toContain("Reviews come from guests who stayed here.");
  });

  test("regression D-13: a review without a rating is rejected and not stored", async () => {
    const listing = await createListing();
    const { agent, user } = await loggedIn();
    const stay = await createCompletedStay({ listing, guest: user });
    const res = await agent
      .post(`/listings/${listing._id}/reviews`)
      .type("form")
      .send(`review[reservation]=${stay._id}&review[comment]=Nice place`);
    expect(res.status).toBe(400);
    expect(await Review.countDocuments({})).toBe(0);
  });

  test("a review of a completed stay is stored with the stay, createdAt/updatedAt and legacy false; a second one is refused", async () => {
    const listing = await createListing();
    const { agent, user } = await loggedIn();
    const stay = await createCompletedStay({ listing, guest: user });
    const send = () =>
      agent
        .post(`/listings/${listing._id}/reviews`)
        .type("form")
        .send(`review[reservation]=${stay._id}&review[rating]=4&review[comment]=Nice place`);
    expect((await send()).status).toBe(302);

    const review = await Review.findOne({});
    expect(review.rating).toBe(4);
    expect(String(review.reservation)).toBe(String(stay._id));
    expect(String(review.listing)).toBe(String(listing._id));
    expect(review.legacy).toBe(false);
    expect(review.createdAt).toBeInstanceOf(Date);
    expect(review.updatedAt).toBeInstanceOf(Date);

    expect((await send()).status).toBe(409);
    expect(await Review.countDocuments({})).toBe(1);
  });

  test("a review without a stay is refused (404), and so is somebody else's stay", async () => {
    const listing = await createListing();
    const { agent } = await loggedIn();
    const { user: other } = await createUser();
    const theirs = await createCompletedStay({ listing, guest: other });
    for (const reservation of [String(theirs._id), "64b0f0f0f0f0f0f0f0f0abcd"]) {
      const res = await agent
        .post(`/listings/${listing._id}/reviews`)
        .type("form")
        .send(`review[reservation]=${reservation}&review[rating]=5&review[comment]=Nice`);
      expect(res.status).toBe(404);
    }
    expect(await Review.countDocuments({})).toBe(0);
  });

  test("regression D-09: reviews created later get later timestamps", async () => {
    const listing = await createListing();
    const first = await createReview({ listing });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await createReview({ listing });
    expect(second.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
  });

  test("only the review's author sees the delete button", async () => {
    const listing = await createListing();
    const { agent: authorAgent, user: author } = await loggedIn();
    await createReview({ listing, author, comment: "Mine" });
    const url = `/listings/${listing._id}`;

    const mine = await authorAgent.get(url);
    expect(mine.text).toContain("Delete Review");

    const other = await (await loggedIn()).agent.get(url);
    expect(other.status).toBe(200);
    expect(other.text).toContain("Mine");
    expect(other.text).not.toContain("Delete Review");

    const anonymous = await createAgent().get(url);
    expect(anonymous.text).not.toContain("Delete Review");
  });

  test("a review whose author account is gone renders without a delete button", async () => {
    const listing = await createListing();
    await createReview({ listing, comment: "Anonymous review" });
    const { agent } = await loggedIn();
    const res = await agent.get(`/listings/${listing._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Unknown User");
    expect(res.text).not.toContain("Delete Review");
  });
});
