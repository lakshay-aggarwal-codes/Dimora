// P04-T06: the rows and actions of the "My listings" page (no database).
const {
  MAX_ROWS,
  formatDay,
  actionsFor,
  toRow,
  loadHostListings,
} = require("../../src/services/hostListings");

const photo = (n) => ({
  url: `https://res.cloudinary.test/p${n}.jpg`,
  publicId: `p${n}`,
});
const READY = (extra = {}) => ({
  _id: "abc123",
  title: "Sunny flat",
  status: "published",
  country: "India",
  images: [1, 2, 3, 4, 5].map(photo),
  description: "x".repeat(200),
  address: { line1: "12 Beach Road", city: "Goa", country: "India" },
  geometry: { type: "Point", coordinates: [73.8, 15.5] },
  needsReview: false,
  capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 },
  pricing: { nightlyMinor: 250000 },
  houseRules: "No smoking.",
  checkInTime: "14:00",
  checkOutTime: "11:00",
  cancellationPolicy: "moderate",
  updatedAt: new Date("2026-10-17T20:00:00.000Z"),
  ...extra,
});

const labels = (actions) => actions.map((a) => `${a.kind}:${a.label}`);

describe("formatDay", () => {
  test("a short day in Indian time (20:00 UTC is already the next day in India)", () => {
    expect(formatDay(new Date("2026-10-17T10:00:00.000Z"))).toBe("17 Oct 2026");
    expect(formatDay(new Date("2026-10-17T20:00:00.000Z"))).toBe("18 Oct 2026");
  });

  test("anything that is not a valid Date gives an empty string", () => {
    for (const bad of [undefined, null, "2026-10-17", 0, {}, new Date("nope")]) {
      expect(formatDay(bad)).toBe("");
    }
  });
});

describe("actionsFor", () => {
  const one = (status, canPublish = false) => actionsFor({ id: "L1", status, canPublish });

  test("a draft carries on in the wizard", () => {
    const actions = one("draft");
    expect(labels(actions)).toEqual(["link:Continue", "link:Status and checklist"]);
    expect(actions[0]).toMatchObject({ href: "/host/listings/L1", primary: true });
  });

  test("a published listing can be viewed, edited, checked and unpublished (a POST)", () => {
    const actions = one("published", true);
    expect(labels(actions)).toEqual([
      "link:View",
      "link:Edit",
      "link:Status and checklist",
      "post:Unpublish",
    ]);
    expect(actions[3].href).toBe("/host/listings/L1/unpublish");
  });

  test("an unpublished listing offers Publish only when the checklist is complete", () => {
    expect(labels(one("unpublished", true))).toContain("post:Publish");
    expect(labels(one("unpublished", false))).not.toContain("post:Publish");
    expect(one("unpublished", true).find((a) => a.label === "Publish").href).toBe(
      "/host/listings/L1/publish",
    );
  });

  test("a suspended listing (or a state nobody has defined yet) only offers the status page", () => {
    expect(labels(one("suspended"))).toEqual(["link:Status and checklist"]);
    expect(labels(one("something-new"))).toEqual(["link:Status and checklist"]);
  });

  test("a POST action is never a link and every other action is", () => {
    for (const status of ["draft", "published", "unpublished", "suspended"]) {
      for (const action of one(status, true)) {
        expect(["link", "post"]).toContain(action.kind);
        expect(action.href.startsWith("/")).toBe(true);
      }
    }
  });
});

describe("toRow", () => {
  test("a finished published listing: 100%, nothing to do, cover and place", () => {
    const row = toRow(READY());
    expect(row).toMatchObject({
      id: "abc123",
      title: "Sunny flat",
      where: "Goa, India",
      coverUrl: "https://res.cloudinary.test/p1.jpg",
      status: "published",
      statusLabel: "Published",
      statusVariant: "success",
      score: 100,
      canPublish: true,
      missing: 0,
      updatedIso: "2026-10-17T20:00:00.000Z",
      updatedLabel: "18 Oct 2026",
    });
    expect(labels(row.actions)).toContain("post:Unpublish");
  });

  test("a bare draft: low score, items to do, no cover, no date, no crash", () => {
    const row = toRow({ _id: "d1", status: "draft" });
    expect(row.title).toBe("Untitled listing");
    expect(row.statusLabel).toBe("Draft");
    expect(row.score).toBe(0);
    expect(row.canPublish).toBe(false);
    expect(row.missing).toBeGreaterThan(0);
    expect(row.coverUrl).toBeNull();
    expect(row.updatedIso).toBe("");
    expect(row.updatedLabel).toBe("");
    expect(row.where).toBe("");
  });

  test("an unpublished listing that is ready can be published again", () => {
    const row = toRow(READY({ status: "unpublished" }));
    expect(row.statusLabel).toBe("Unpublished");
    expect(labels(row.actions)).toContain("post:Publish");
  });

  test("the score and the count of missing items agree with the checklist", () => {
    const row = toRow(READY({ images: [photo(1)] })); // needs 5 photos
    expect(row.canPublish).toBe(false);
    expect(row.missing).toBe(1);
    expect(row.score).toBeLessThan(100);
    expect(row.score).toBeGreaterThan(0);
  });

  test("an unknown status is shown as a draft rather than breaking the page", () => {
    expect(toRow(READY({ status: "weird" })).statusLabel).toBe("Draft");
  });

  test("text is passed through untouched (the view escapes it)", () => {
    expect(toRow(READY({ title: "<b>x</b>" })).title).toBe("<b>x</b>");
  });
});

describe("loadHostListings", () => {
  function fakeModel(listings) {
    const calls = {};
    const chain = {
      sort(arg) {
        calls.sort = arg;
        return chain;
      },
      limit(arg) {
        calls.limit = arg;
        return chain;
      },
      then(resolve, reject) {
        return Promise.resolve(listings).then(resolve, reject);
      },
    };
    return {
      calls,
      find(filter) {
        calls.filter = filter;
        return chain;
      },
    };
  }

  test("asks for this host's listings that are not deleted, newest change first", async () => {
    const model = fakeModel([READY()]);
    const { rows, truncated } = await loadHostListings(model, "owner1");
    expect(model.calls.filter).toEqual({ owner: "owner1", deletedAt: null });
    expect(model.calls.sort).toEqual({ updatedAt: -1, _id: -1 });
    expect(model.calls.limit).toBe(MAX_ROWS + 1);
    expect(rows).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  test("more than the limit is cut and reported", async () => {
    const many = Array.from({ length: 4 }, (_, i) => READY({ _id: `id${i}` }));
    const { rows, truncated } = await loadHostListings(fakeModel(many), "o", { limit: 3 });
    expect(rows.map((r) => r.id)).toEqual(["id0", "id1", "id2"]);
    expect(truncated).toBe(true);
  });

  test("exactly the limit is not truncated; nothing at all is an empty list", async () => {
    const three = Array.from({ length: 3 }, (_, i) => READY({ _id: `id${i}` }));
    expect((await loadHostListings(fakeModel(three), "o", { limit: 3 })).truncated).toBe(false);
    expect(await loadHostListings(fakeModel([]), "o")).toEqual({ rows: [], truncated: false });
    expect(await loadHostListings(fakeModel(null), "o")).toEqual({ rows: [], truncated: false });
  });
});
