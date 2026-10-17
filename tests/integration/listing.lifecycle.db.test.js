// P04-T05 through the real routes: the status page, publish / unpublish,
// the guest preview and soft delete. Needs a MongoDB (see tests/helpers/db.js);
// skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const {
  createUser,
  createListing,
  createReview,
} = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const StayNight = require("../../src/models/stayNight");
const { addDays, todayIn } = require("../../src/utils/dates");

const photos = () =>
  [1, 2, 3, 4, 5].map((n) => ({
    url: `https://res.cloudinary.test/dimora_DEV/life${n}.jpg`,
    publicId: `dimora_DEV/life${n}`,
    alt: "",
    caption: "",
    order: n - 1,
  }));
const READY = () => ({
  images: photos(),
  description:
    "A bright, quiet flat close to the beach with everything you need. ".repeat(
      4,
    ),
  address: { line1: "12 Beach Road", city: "Goa", country: "India" },
  needsReview: false,
  houseRules: "No smoking.",
});

async function signedIn() {
  const { user, password } = await createUser();
  const agent = await login(createAgent(), {
    username: user.username,
    password,
  });
  return { agent, user };
}
const status = (listing) => `/host/listings/${listing._id}/status`;
const reload = (listing) => Listing.findById(listing._id);

describeDb("listing lifecycle", () => {
  useTestDb();

  describe("status page", () => {
    test("the owner sees the checklist; a stranger gets 403; a visitor is sent to log in", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({ owner: user._id, status: "draft" });
      const page = await agent.get(status(listing));
      expect(page.status).toBe(200);
      expect(page.text).toContain("Ready to publish?");
      expect(page.text).toContain("At least 5 photos");
      expect((await createAgent().get(status(listing))).status).toBe(302);
      const other = await signedIn();
      expect((await other.agent.get(status(listing))).status).toBe(403);
    });

    test("a deleted listing has no status page", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        deletedAt: new Date(),
      });
      expect((await agent.get(status(listing))).status).toBe(404);
    });
  });

  describe("publish", () => {
    test("an unpublished listing that is ready can be published again, and is public at once", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "unpublished",
        ...READY(),
      });
      const res = await agent.post(`/host/listings/${listing._id}/publish`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${listing._id}`);
      expect((await reload(listing)).status).toBe("published");
      expect((await createAgent().get(`/listings/${listing._id}`)).status).toBe(
        200,
      );
    });

    test("one missing item keeps it unpublished and says which", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "unpublished",
        ...READY(),
        houseRules: "",
      });
      const res = await agent.post(`/host/listings/${listing._id}/publish`);
      expect(res.headers.location).toBe(status(listing));
      expect((await reload(listing)).status).toBe("unpublished");
      const page = await agent.get(status(listing));
      expect(page.text).toContain("no special rules");
    });

    test('"no special rules" confirmed is enough for the rules item', async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "unpublished",
        ...READY(),
        houseRules: "",
        noSpecialRules: true,
      });
      await agent.post(`/host/listings/${listing._id}/publish`);
      expect((await reload(listing)).status).toBe("published");
    });

    test("someone else cannot publish it (403) and nothing changes", async () => {
      const { user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "unpublished",
        ...READY(),
      });
      const other = await signedIn();
      expect(
        (await other.agent.post(`/host/listings/${listing._id}/publish`))
          .status,
      ).toBe(403);
      expect((await reload(listing)).status).toBe("unpublished");
    });

    test("a deleted listing cannot be published", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "unpublished",
        deletedAt: new Date(),
        ...READY(),
      });
      expect(
        (await agent.post(`/host/listings/${listing._id}/publish`)).status,
      ).toBe(404);
      expect((await reload(listing)).status).toBe("unpublished");
    });
  });

  describe("unpublish", () => {
    test("hides the listing at once everywhere; the host can still see it, with a notice", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({ owner: user._id, ...READY() });
      const visitor = createAgent();
      expect((await visitor.get("/listings")).text).toContain(listing.title);

      const res = await agent.post(`/host/listings/${listing._id}/unpublish`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(status(listing));
      expect((await reload(listing)).status).toBe("unpublished");

      expect((await visitor.get("/listings")).text).not.toContain(
        listing.title,
      );
      expect((await visitor.get("/")).text).not.toContain(listing.title);
      expect((await visitor.get(`/listings/${listing._id}`)).status).toBe(302);
      const own = await agent.get(`/listings/${listing._id}`);
      expect(own.status).toBe(200);
      expect(own.text).toContain("only you can see it");
    });

    test("unpublishing twice is harmless", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({ owner: user._id, ...READY() });
      await agent.post(`/host/listings/${listing._id}/unpublish`);
      const again = await agent.post(`/host/listings/${listing._id}/unpublish`);
      expect(again.status).toBe(302);
      expect((await reload(listing)).status).toBe("unpublished");
    });

    test("a stranger cannot unpublish (403)", async () => {
      const { user } = await signedIn();
      const listing = await createListing({ owner: user._id, ...READY() });
      const other = await signedIn();
      expect(
        (await other.agent.post(`/host/listings/${listing._id}/unpublish`))
          .status,
      ).toBe(403);
      expect((await reload(listing)).status).toBe("published");
    });

    test("nobody can post a review on an unpublished listing", async () => {
      const { user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "unpublished",
        ...READY(),
      });
      const guest = await signedIn();
      const res = await guest.agent
        .post(`/listings/${listing._id}/reviews`)
        .type("form")
        .send({ "review[rating]": "5", "review[comment]": "Nice" });
      expect(res.status).toBe(404);
      expect(await Review.countDocuments()).toBe(0);
    });
  });

  describe("preview as a guest", () => {
    test("the owner sees the guest view without host controls", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "draft",
        ...READY(),
      });
      const res = await agent.get(`/listings/${listing._id}?preview=1`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("This is how guests see your listing");
      expect(res.text).not.toContain(`/listings/${listing._id}/edit`);
      expect(res.text).not.toContain("?_method=DELETE");
    });

    test("without ?preview=1 the owner of a draft sees the host view and the notice", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "draft",
        ...READY(),
      });
      const res = await agent.get(`/listings/${listing._id}`);
      expect(res.text).toContain("only you can see it");
      expect(res.text).toContain(`/listings/${listing._id}/edit`);
    });

    test("another signed-in user, a visitor and an admin all get 404", async () => {
      const { user } = await signedIn();
      const listing = await createListing({
        owner: user._id,
        status: "draft",
        ...READY(),
      });
      const url = `/listings/${listing._id}?preview=1`;
      const other = await signedIn();
      expect((await other.agent.get(url)).status).toBe(404);
      expect((await createAgent().get(url)).status).toBe(404);
      const { user: admin, password } = await createUser();
      await admin.constructor.updateOne({ _id: admin._id }, { role: "admin" });
      const adminAgent = await login(createAgent(), {
        username: admin.username,
        password,
      });
      expect((await adminAgent.get(url)).status).toBe(404);
    });
  });

  describe("soft delete", () => {
    test("the listing disappears for everyone; the row and its reviews stay", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({ owner: user._id, ...READY() });
      const reviewer = await signedIn();
      const review = await createReview({ listing, author: reviewer.user });

      const res = await agent.delete(`/listings/${listing._id}`);
      expect(res.status).toBe(302);
      const stored = await reload(listing);
      expect(stored.deletedAt).toBeInstanceOf(Date);
      expect(stored.status).toBe("unpublished");
      expect(await Review.findById(review._id)).not.toBeNull();

      expect((await createAgent().get("/listings")).text).not.toContain(
        listing.title,
      );
      expect((await createAgent().get("/")).text).not.toContain(listing.title);
      expect((await createAgent().get(`/listings/${listing._id}`)).status).toBe(
        302,
      );
      expect((await agent.get(`/listings/${listing._id}`)).status).toBe(302); // gone for the owner too
      expect((await agent.get(status(listing))).status).toBe(404);
    });

    test("an upcoming reservation blocks it, with a message on the status page", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({ owner: user._id, ...READY() });
      const tomorrow = addDays(todayIn("Asia/Kolkata"), 1);
      await StayNight.create({
        listing: listing._id,
        date: tomorrow,
        source: { kind: "reservation", id: new mongoose.Types.ObjectId() },
      });
      const res = await agent.delete(`/listings/${listing._id}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(status(listing));
      expect((await reload(listing)).deletedAt).toBeFalsy();
      const page = await agent.get(status(listing));
      expect(page.text).toContain("upcoming reservations");
    });

    test("a reservation in the past, or a host block, does not block it", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({ owner: user._id, ...READY() });
      const today = todayIn("Asia/Kolkata");
      await StayNight.create({
        listing: listing._id,
        date: addDays(today, -3),
        source: { kind: "reservation", id: new mongoose.Types.ObjectId() },
      });
      await StayNight.create({
        listing: listing._id,
        date: addDays(today, 5),
        source: { kind: "block", id: new mongoose.Types.ObjectId() },
      });
      await agent.delete(`/listings/${listing._id}`);
      expect((await reload(listing)).deletedAt).toBeInstanceOf(Date);
    });

    test("deleting twice is harmless", async () => {
      const { agent, user } = await signedIn();
      const listing = await createListing({ owner: user._id, ...READY() });
      await agent.delete(`/listings/${listing._id}`);
      const first = (await reload(listing)).deletedAt;
      const again = await agent.delete(`/listings/${listing._id}`);
      expect([302, 404]).toContain(again.status);
      expect((await reload(listing)).deletedAt).toEqual(first);
    });
  });
});
