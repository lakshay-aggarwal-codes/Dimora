// P12-T04: where the Report links appear (listing page, its reviews, profiles,
// the account menu) through the real app and views; no database. The viewer is
// set with the passport stubs used by the checkout tests.
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const ejsMate = require("ejs-mate");
const { ObjectId } = require("mongoose").Types;
const { createAgent, login } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");
const reviewService = require("../../src/services/reviews");
const User = require("../../src/models/user");
const { can } = require("../../src/policies");
const { fullTitle, metaDescription } = require("../../src/utils/pageMeta");

const current = { user: null };
beforeEach(() => {
  current.user = null;
  jest
    .spyOn(User, "authenticate")
    .mockReturnValue((u, p, done) => done(null, current.user));
  jest
    .spyOn(User, "serializeUser")
    .mockReturnValue((u, done) => done(null, String(u._id)));
  jest
    .spyOn(User, "deserializeUser")
    .mockReturnValue((id, done) => done(null, current.user));
});
afterEach(() => jest.restoreAllMocks());

const member = () =>
  new User({ username: "viewer", email: "viewer@example.com" });

function stubListing(doc) {
  // A signed-in viewer makes the page ask whether they have a stay to review
  // (P12-T01): that is a database question, so it is answered here.
  jest.spyOn(reviewService, "findReviewable").mockResolvedValue(null);
  const query = {
    populate: () => query,
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
  };
  jest.spyOn(Listing, "findById").mockReturnValue(query);
}

async function page(viewer, { owner } = {}) {
  const doc = new Listing(
    buildListingData({
      owner: owner || new ObjectId(),
      title: "Seaside Cottage",
    }),
  );
  stubListing(doc);
  const agent = createAgent();
  if (viewer) {
    current.user = viewer;
    await login(agent, { username: "viewer", password: "irrelevant-password" });
  }
  const res = await agent.get(`/listings/${doc._id}`);
  return { res, doc };
}

describe("the listing page", () => {
  test("a visitor who is not signed in sees the link (it asks them to log in first)", async () => {
    const { res, doc } = await page(null);
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      `href="/reports/new?kind=listing&amp;id=${doc._id}"`.replace(
        "&amp;",
        "&",
      ),
    );
    expect(res.text).toContain("Report this listing");
  });

  test("another member sees it", async () => {
    const { res } = await page(member());
    expect(res.text).toContain("Report this listing");
  });

  test("the host does not see it on their own listing", async () => {
    const viewer = member();
    const { res } = await page(viewer, { owner: viewer._id });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("Report this listing");
  });

  test("the link goes through the login page and back: /reports/new needs a login", async () => {
    const { doc } = await page(null);
    const res = await createAgent().get(
      `/reports/new?kind=listing&id=${doc._id}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });
});

describe("reviews on the listing page", () => {
  async function pageWithReview(viewer, authorId) {
    const doc = new Listing(
      buildListingData({ owner: new ObjectId(), title: "Seaside Cottage" }),
    );
    const review = new Review({ comment: "Nice", rating: 4, author: authorId });
    review.author = { _id: authorId, username: "ravi" };
    doc.reviews = [review._id];
    doc.$populated("reviews", [review._id], {});
    doc.reviews = [
      Object.assign(review, { author: { _id: authorId, username: "ravi" } }),
    ];
    stubListing(doc);
    const agent = createAgent();
    if (viewer) {
      current.user = viewer;
      await login(agent, {
        username: "viewer",
        password: "irrelevant-password",
      });
    }
    return { res: await agent.get(`/listings/${doc._id}`), review };
  }

  test("each review has a Report link for visitors and other members", async () => {
    const { res, review } = await pageWithReview(null, new ObjectId());
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      `href="/reports/new?kind=review&id=${review._id}"`,
    );
    const other = await pageWithReview(member(), new ObjectId());
    expect(other.res.text).toContain("Report this review");
  });

  test("not on your own review", async () => {
    const viewer = member();
    const { res } = await pageWithReview(viewer, viewer._id);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("Report this review");
  });
});

describe("the account menu", () => {
  test("a signed-in member has Your reports", async () => {
    const { res } = await page(member());
    expect(res.text).toMatch(
      /<a class="dropdown-item" href="\/reports"[^>]*>Your reports<\/a>/,
    );
  });
  test("a visitor does not", async () => {
    const { res } = await page(null);
    expect(res.text).not.toContain("Your reports");
  });
});

describe("a member's profile", () => {
  const ROOT = path.join(__dirname, "..", "..");
  function profileApp(user) {
    const a = express();
    a.set("view engine", "ejs");
    a.set("views", path.join(ROOT, "views"));
    a.engine("ejs", ejsMate);
    Object.assign(a.locals, { fullTitle, metaDescription, imageUrl: (u) => u });
    a.use((req, res, next) => {
      Object.assign(res.locals, {
        success: [],
        error: [],
        currUser: user,
        currentPath: "/",
        can: (action, resource) => can(action, user, resource),
        csrfToken: "t",
        cspNonce: "n",
        mapPublicToken: "",
        formatMoney: String,
      });
      next();
    });
    const profile = {
      id: "64b7f0c2a1b2c3d4e5f60718",
      displayName: "Asha",
      username: "asha",
      avatarUrl: null,
      bio: "",
      memberSince: "October 2026",
      listingCount: 1,
      reviewCount: 0,
      hostCancellationCount: 0,
      reviews: [],
    };
    a.get("/p", (req, res) =>
      res.render("users/profile.ejs", {
        profile,
        isOwn: req.query.own === "1",
        pageTitle: "p",
      }),
    );
    return a;
  }
  test("shown to visitors and other members, not on your own profile", async () => {
    expect((await request(profileApp(undefined)).get("/p")).text).toContain(
      'href="/reports/new?kind=user&id=64b7f0c2a1b2c3d4e5f60718"',
    );
    expect(
      (
        await request(
          profileApp({ _id: new ObjectId(), status: "active", role: "member" }),
        ).get("/p")
      ).text,
    ).toContain("Report this member");
    expect(
      (
        await request(
          profileApp({ _id: new ObjectId(), status: "active", role: "member" }),
        ).get("/p?own=1")
      ).text,
    ).not.toContain("Report this member");
  });
  test("not shown to an account that cannot report (suspended)", async () => {
    expect(
      (
        await request(
          profileApp({
            _id: new ObjectId(),
            status: "suspended",
            role: "member",
          }),
        ).get("/p")
      ).text,
    ).not.toContain("Report this member");
  });
});
