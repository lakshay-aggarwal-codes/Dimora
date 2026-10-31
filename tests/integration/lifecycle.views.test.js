// P04-T05 without a database: the checklist markup, the guards on the new
// routes, and who may see (or preview) a listing. The model is stubbed.
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { stubListingSearch } = require("../helpers/listingSearch");
const { evaluateReadiness } = require("../../src/services/readiness");
const { stubListings } = require("../helpers/listingsStub");

const VIEWS = path.join(__dirname, "..", "..", "views");
const renderPartial = (name, locals) =>
  ejs.renderFile(path.join(VIEWS, "partials", `${name}.ejs`), locals);
const squash = (html) => html.replace(/\s+/g, " ").trim();

function stubFindById(doc) {
  const query = {
    populate: () => query,
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}
const make = (overrides = {}) => new Listing(buildListingData(overrides));

afterEach(() => jest.restoreAllMocks());

describe("readiness partial", () => {
  const draft = { _id: "64b0f0f0f0f0f0f0f0f0aaaa", status: "draft" };

  test("a listing with nothing done: score, to-do items in words, links to the wizard step", async () => {
    const html = squash(
      await renderPartial("readiness", {
        listing: draft,
        readiness: evaluateReadiness({}),
      }),
    );
    expect(html).toContain("<strong>0%</strong> of the checklist is done.");
    expect(html).toContain(
      '<progress class="readiness-bar" max="100" value="0"',
    );
    expect(html).toContain(": to do");
    expect(html).not.toContain(": done");
    expect(html).toContain(
      'href="/host/listings/64b0f0f0f0f0f0f0f0f0aaaa/steps/4"',
    ); // photos
    expect(html).toContain(
      'href="/host/listings/64b0f0f0f0f0f0f0f0f0aaaa/steps/1"',
    ); // description
    expect(html).toContain("At least 5 photos");
    expect(html).toContain("Some items are still to do.");
  });

  test("a finished listing: every item says done and there are no fix links", async () => {
    const ready = {
      images: [1, 2, 3, 4, 5].map((n) => ({ url: `https://x/${n}.jpg` })),
      description: "x".repeat(200),
      address: { line1: "1 Road", city: "Goa", country: "India" },
      geometry: { type: "Point", coordinates: [1, 2] },
      capacity: { guests: 2, beds: 1 },
      pricing: { nightlyMinor: 100000 },
      noSpecialRules: true,
      checkInTime: "14:00",
      checkOutTime: "11:00",
      cancellationPolicy: "flexible",
    };
    const html = squash(
      await renderPartial("readiness", {
        listing: draft,
        readiness: evaluateReadiness(ready),
      }),
    );
    expect(html).toContain("<strong>100%</strong>");
    expect(html).toContain("Everything is done.");
    expect((html.match(/: done/g) || []).length).toBe(8);
    expect(html).not.toContain("Fix this");
  });

  test("for a listing that is no longer a draft, the fix links go to the edit page", async () => {
    const html = await renderPartial("readiness", {
      listing: { ...draft, status: "unpublished" },
      readiness: evaluateReadiness({}),
    });
    expect(html).toContain('href="/listings/64b0f0f0f0f0f0f0f0f0aaaa/edit"');
    expect(html).not.toContain("/steps/");
  });

  test("the item state is never colour only (✓ and 'done'/'to do' text)", async () => {
    const html = await renderPartial("readiness", {
      listing: draft,
      readiness: evaluateReadiness({}),
    });
    expect(html).toContain("visually-hidden");
    expect(html).toMatch(/aria-hidden="true">•</);
  });
});

describe("views compile", () => {
  test.each([
    "host/status.ejs",
    "host/steps/review.ejs",
    "host/steps/pricing.ejs",
    "listings/show.ejs",
  ])("%s", (file) => {
    const source = fs.readFileSync(path.join(VIEWS, file), "utf8");
    expect(() =>
      ejs.compile(source, { filename: path.join(VIEWS, file) }),
    ).not.toThrow();
  });
});

describe("the new host routes need a signed-in user", () => {
  const id = "64b0f0f0f0f0f0f0f0f0aaaa";
  test.each([
    ["get", `/host/listings/${id}/status`],
    ["post", `/host/listings/${id}/publish`],
    ["post", `/host/listings/${id}/unpublish`],
    ["delete", `/listings/${id}`],
  ])("anonymous %s %s -> /login", async (method, url) => {
    const res = await createAgent()[method](url).type("form").send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });
});

describe("who sees what", () => {
  test("a published listing is public; ?preview=1 is not available to visitors (404)", async () => {
    const doc = make({ status: "published" });
    stubFindById(doc);
    expect((await createAgent().get(`/listings/${doc._id}`)).status).toBe(200);
    expect(
      (await createAgent().get(`/listings/${doc._id}?preview=1`)).status,
    ).toBe(404);
  });

  test("a draft is a 404 for visitors, and so is its preview", async () => {
    const doc = make({ status: "draft" });
    stubFindById(doc);
    const plain = await createAgent().get(`/listings/${doc._id}`);
    expect(plain.status).toBe(404);
    const preview = await createAgent().get(`/listings/${doc._id}?preview=1`);
    expect(preview.status).toBe(404);
    expect(preview.text).not.toContain(doc.title);
  });

  test("an unpublished listing looks missing to visitors", async () => {
    const doc = make({ status: "unpublished" });
    stubFindById(doc);
    expect((await createAgent().get(`/listings/${doc._id}`)).status).toBe(404);
  });

  test("a deleted listing is gone for visitors even if it was published", async () => {
    const doc = make({ status: "published" });
    doc.deletedAt = new Date();
    stubFindById(doc);
    expect((await createAgent().get(`/listings/${doc._id}`)).status).toBe(404);
    expect(
      (await createAgent().get(`/listings/${doc._id}?preview=1`)).status,
    ).toBe(404);
  });

  test("a listing that does not exist: preview is a 404 too", async () => {
    stubFindById(null);
    expect(
      (await createAgent().get("/listings/64b0f0f0f0f0f0f0f0f0bbbb?preview=1"))
        .status,
    ).toBe(404);
  });

  test("the public list and the home page ask only for published, not deleted listings", async () => {
    const { find } = stubListingSearch([]);
    await createAgent().get("/listings");
    expect(find).toHaveBeenCalledWith({ status: "published", deletedAt: null });
  });
});
