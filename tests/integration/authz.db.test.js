// P02-T06: object-level access through the real routes (matrix of
// anonymous / other member / owner / admin x listing edit, update, delete and
// review delete). Needs a MongoDB; skipped with SKIP_DB_TESTS=1.
// Extend this file when a later task adds a route with an ownership rule.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const {
  createUser,
  createListing,
  createReview,
} = require("../helpers/factories");
const { uploader, resetExternalMocks } = require("../helpers/mocks");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const User = require("../../src/models/user");

async function agentFor(overrides) {
  const { user, password } = await createUser(overrides);
  const agent = await login(createAgent(), {
    username: user.username,
    password,
  });
  return { agent, user };
}

async function admin() {
  const made = await agentFor();
  await User.updateOne({ _id: made.user._id }, { role: "admin" });
  return made;
}

afterEach(resetExternalMocks);

describeDb("object-level authorization (database)", () => {
  useTestDb();

  async function world() {
    const owner = await agentFor();
    const listing = await createListing({
      owner: owner.user,
      title: "Original title",
    });
    const reviewer = await agentFor();
    const review = await createReview({ listing, author: reviewer.user });
    return {
      owner,
      listing,
      reviewer,
      review,
      stranger: await agentFor(),
      admin: await admin(),
      anonymous: { agent: createAgent() },
    };
  }

  const editPath = (w) => `/listings/${w.listing._id}/edit`;
  const showPath = (w) => `/listings/${w.listing._id}`;
  const reviewPath = (w) =>
    `/listings/${w.listing._id}/reviews/${w.review._id}`;

  // person -> expected status. Anonymous is sent to the login page (302).
  describe("GET /listings/:id/edit", () => {
    test.each([
      ["anonymous", 302],
      ["stranger", 403],
      ["owner", 200],
      ["admin", 403], // admins moderate (delete); they do not edit hosts' listings
    ])("%s -> %i", async (who, status) => {
      const w = await world();
      const res = await w[who].agent.get(editPath(w));
      expect(res.status).toBe(status);
      if (who === "anonymous") expect(res.headers.location).toBe("/login");
    });
  });

  describe("PUT /listings/:id", () => {
    test.each([
      ["anonymous", 302, "Original title"],
      ["stranger", 403, "Original title"],
      ["admin", 403, "Original title"],
      ["owner", 302, "Edited"],
    ])("%s -> %i, title '%s'", async (who, status, title) => {
      const w = await world();
      const res = await w[who].agent
        .put(showPath(w))
        .field("listing[title]", "Edited")
        .field("listing[description]", "Steps from the beach.")
        .field("listing[location]", w.listing.location)
        .field("listing[country]", w.listing.country)
        .field("listing[price]", "2500");
      expect(res.status).toBe(status);
      expect((await Listing.findById(w.listing._id)).title).toBe(title);
    });
  });

  describe("DELETE /listings/:id", () => {
    test.each([
      ["anonymous", 302, true],
      ["stranger", 403, true],
      ["owner", 302, false],
      ["admin", 302, false],
    ])("%s -> %i, listing kept: %s", async (who, status, kept) => {
      const w = await world();
      const res = await w[who].agent.delete(showPath(w));
      expect(res.status).toBe(status);
      expect(Boolean(await Listing.findById(w.listing._id))).toBe(kept);
    });
  });

  describe("DELETE /listings/:id/reviews/:reviewId", () => {
    test.each([
      ["anonymous", 302, true],
      ["stranger", 403, true],
      ["owner", 403, true], // the host is not the review's author
      ["reviewer", 302, false],
      ["admin", 302, false],
    ])("%s -> %i, review kept: %s", async (who, status, kept) => {
      const w = await world();
      const res = await w[who].agent.delete(reviewPath(w));
      expect(res.status).toBe(status);
      expect(Boolean(await Review.findById(w.review._id))).toBe(kept);
    });

    test("a review is not reachable through another listing's URL", async () => {
      const w = await world();
      const other = await createListing({ owner: w.owner.user });
      const res = await w.reviewer.agent.delete(
        `/listings/${other._id}/reviews/${w.review._id}`,
      );
      expect(res.status).toBe(404);
      expect(await Review.findById(w.review._id)).not.toBeNull();
    });

    test("a missing review or listing is a 404", async () => {
      const w = await world();
      const missing = new mongoose.Types.ObjectId();
      expect(
        (
          await w.reviewer.agent.delete(
            `/listings/${w.listing._id}/reviews/${missing}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (await w.reviewer.agent.delete(`/listings/${missing}/reviews/${missing}`))
          .status,
      ).toBe(404);
    });
  });

  describe("suspended accounts", () => {
    test("a suspended owner can no longer edit or delete", async () => {
      const w = await world();
      await User.updateOne({ _id: w.owner.user._id }, { status: "suspended" });
      expect((await w.owner.agent.get(editPath(w))).status).toBe(403);
      expect((await w.owner.agent.delete(showPath(w))).status).toBe(403);
      expect(await Listing.findById(w.listing._id)).not.toBeNull();
    });

    test("a suspended member cannot create a listing page or post a review", async () => {
      const w = await world();
      await User.updateOne({ _id: w.stranger.user._id }, { status: "suspended" });
      expect((await w.stranger.agent.get("/listings/new")).status).toBe(403);
      const res = await w.stranger.agent
        .post(`${showPath(w)}/reviews`)
        .type("form")
        .send("review[rating]=4&review[comment]=Nice");
      expect(res.status).toBe(403);
      expect(await Review.countDocuments({ author: w.stranger.user._id })).toBe(0);
    });
  });

  describe("detail page buttons follow the same policies", () => {
    test.each([
      ["anonymous", false, false],
      ["stranger", false, false],
      ["owner", true, true],
      ["admin", false, true],
    ])("%s: edit link %s, delete form %s", async (who, edit, del) => {
      const w = await world();
      const html = (await w[who].agent.get(showPath(w))).text;
      expect(html.includes(`href="${editPath(w)}"`)).toBe(edit);
      expect(html.includes(`action="${showPath(w)}?_method=DELETE"`)).toBe(del);
    });

    test("the review delete button is shown to its author and an admin only", async () => {
      const w = await world();
      const marker = "Delete Review";
      expect((await w.reviewer.agent.get(showPath(w))).text).toContain(marker);
      expect((await w.admin.agent.get(showPath(w))).text).toContain(marker);
      expect((await w.stranger.agent.get(showPath(w))).text).not.toContain(marker);
      expect((await w.owner.agent.get(showPath(w))).text).not.toContain(marker);
      expect((await w.anonymous.agent.get(showPath(w))).text).not.toContain(marker);
    });
  });
});
