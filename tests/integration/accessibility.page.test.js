// P15-T05 through the real app and views, no database: the listing page shows
// the host's declared accessibility features with the "declared" notice and a
// report link; the report form can open with "inaccurate" already chosen.
const { ObjectId } = require("mongoose").Types;
const { createAgent, login } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const User = require("../../src/models/user");
const reviewService = require("../../src/services/reviews");
const { ACCESSIBILITY_NOTICE } = require("../../src/config/constants");

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
  jest.spyOn(reviewService, "findReviewable").mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());

const member = () =>
  new User({ username: "viewer", email: "viewer@example.com" });

function stubListing(doc) {
  const query = {
    populate: () => query,
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
  };
  jest.spyOn(Listing, "findById").mockReturnValue(query);
}

async function openListing(accessibility, viewer = null) {
  const doc = new Listing(
    buildListingData({
      owner: new ObjectId(),
      title: "Seaside Cottage",
      accessibility,
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

const section = (html) =>
  (html.match(/<section[^>]*data-accessibility>[\s\S]*?<\/section>/) || [
    "",
  ])[0];

describe("the listing page", () => {
  test("lists the declared features, in the list's order, under a labelled heading with the notice", async () => {
    const { res } = await openListing([
      "grab_rails",
      "step_free_entrance",
      "elevator",
    ]);
    expect(res.status).toBe(200);
    const html = section(res.text);
    expect(html).toContain('aria-labelledby="accessibility-heading"');
    expect(html).toContain(
      '<h2 id="accessibility-heading" class="h4">Accessibility</h2>',
    );
    expect(html).toContain(ACCESSIBILITY_NOTICE);
    const items = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(items).toEqual([
      "Step-free entrance",
      "Elevator",
      "Grab rails in the bathroom",
    ]);
    expect(res.text.match(/id="accessibility-heading"/g)).toHaveLength(1);
  });

  test("makes no claim of checking", async () => {
    const { res } = await openListing(["elevator"]);
    expect(section(res.text)).not.toMatch(
      /verified|certified|guaranteed|inspected/i,
    );
  });

  test("no section at all when the host declared nothing, or only unknown keys", async () => {
    expect((await openListing([])).res.text).not.toContain(
      "data-accessibility",
    );
    expect((await openListing(undefined)).res.text).not.toContain(
      "data-accessibility",
    );
    expect(
      (await openListing(["<script>alert(1)</script>", "jacuzzi"])).res.text,
    ).not.toContain("data-accessibility");
  });

  test("an unknown stored key is dropped, never printed", async () => {
    const { res } = await openListing([
      "elevator",
      "<img src=x onerror=alert(1)>",
    ]);
    expect(section(res.text)).not.toContain("<img");
    expect(section(res.text)).toContain("Elevator");
  });

  test('a signed-in guest gets the report link, already pointing at "inaccurate"', async () => {
    const { res, doc } = await openListing(["elevator"], member());
    expect(section(res.text)).toContain(
      `href="/reports/new?kind=listing&amp;id=${doc._id}&amp;reason=inaccurate"`,
    );
    expect(section(res.text)).toContain(
      "Report inaccurate accessibility information",
    );
  });

  test("the host does not get a link to report themselves", async () => {
    const owner = member();
    const doc = new Listing(
      buildListingData({ owner: owner._id, accessibility: ["elevator"] }),
    );
    stubListing(doc);
    const agent = createAgent();
    current.user = owner;
    await login(agent, { username: "viewer", password: "irrelevant-password" });
    const res = await agent.get(`/listings/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-accessibility");
    expect(res.text).not.toContain(
      "Report inaccurate accessibility information",
    );
  });
});

describe("the report form", () => {
  async function form(query) {
    const doc = {
      _id: new ObjectId(),
      title: "Seaside Cottage",
      owner: new ObjectId(),
      status: "published",
      deletedAt: null,
    };
    const chain = { select: () => chain, lean: () => Promise.resolve(doc) };
    jest.spyOn(Listing, "findById").mockReturnValue(chain);
    const agent = createAgent();
    current.user = member();
    await login(agent, { username: "viewer", password: "irrelevant-password" });
    return agent.get(`/reports/new?kind=listing&id=${doc._id}${query}`);
  }

  test("reason=inaccurate opens with that reason chosen", async () => {
    const res = await form("&reason=inaccurate");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(
      /id="reason-inaccurate" value="inaccurate" checked/,
    );
    expect(res.text.match(/name="reason"[^>]* checked/g)).toHaveLength(1);
  });

  test("a reason that is not on the list, or no reason, chooses nothing", async () => {
    for (const q of ["&reason=nonsense", "&reason[]=inaccurate", ""]) {
      const res = await form(q);
      expect(res.status).toBe(200);
      expect(res.text.match(/name="reason"[^>]* checked/g)).toBeNull();
    }
  });
});
