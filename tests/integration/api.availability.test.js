// P07-T04: GET /api/listings/:id/availability through the real app, no database.
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const ledger = require("../../src/services/ledger");

const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

// Dates relative to today, so the booking window never makes a test stale.
const offset = (n) => addDays(todayIn(), n);
const text = (n) => formatDateOnly(offset(n));

function stubFindById(doc) {
  const query = {
    select: () => query,
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}

afterEach(() => jest.restoreAllMocks());

const URL = (id, qs) => `/api/listings/${id}/availability?${qs}`;

describe("availability API", () => {
  test("returns only dates and rules, no cache, JSON", async () => {
    const doc = new Listing(buildListingData({ minNights: 2, maxNights: 10 }));
    stubFindById(doc);
    const spy = jest
      .spyOn(ledger, "unavailableDates")
      .mockResolvedValue([offset(12), offset(13)]);

    const res = await createAgent().get(URL(doc._id, `from=${text(10)}&to=${text(40)}`));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual(["from", "rules", "to", "unavailable"]);
    expect(res.body.unavailable).toEqual([text(12), text(13)]);
    expect(res.body.rules).toEqual(expect.objectContaining({ minNights: 2, maxNights: 10 }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res.body)).not.toMatch(/guest|source|reservation|block|owner|user/i);
  });

  test("a block and a reservation produce identical output", async () => {
    const doc = new Listing(buildListingData());
    stubFindById(doc);
    const spy = jest.spyOn(ledger, "unavailableDates");
    const qs = `from=${text(10)}&to=${text(40)}`;
    spy.mockResolvedValueOnce([offset(12)]);
    const a = await createAgent().get(URL(doc._id, qs));
    spy.mockResolvedValueOnce([offset(12)]);
    const b = await createAgent().get(URL(doc._id, qs));
    expect(a.body).toEqual(b.body);
  });

  test.each([
    ["missing from", "to=2099-02-01"],
    ["bad date", "from=2099-02-30&to=2099-03-01"],
    ["array", "from=2099-01-01&from=2099-01-02&to=2099-02-01"],
    ["reversed", "from=2099-02-01&to=2099-01-01"],
    ["too long", "from=2099-01-01&to=2100-03-01"],
  ])("400 JSON for %s", async (_name, qs) => {
    const doc = new Listing(buildListingData());
    stubFindById(doc);
    const spy = jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const res = await createAgent().get(URL(doc._id, qs));
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(spy).not.toHaveBeenCalled();
  });

  test.each([
    ["unknown id", null],
    ["draft", { status: "draft" }],
    ["unpublished", { status: "unpublished" }],
    ["deleted", { status: "published", deletedAt: new Date() }],
  ])("404 JSON for a listing that is %s (anonymous)", async (_name, extra) => {
    stubFindById(extra === null ? null : new Listing(buildListingData(extra)));
    const spy = jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const res = await createAgent().get(URL("64b0f0f0f0f0f0f0f0f0aaaa", "from=2099-01-01&to=2099-02-01"));
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a malformed id is a 404, not a 500", async () => {
    const res = await createAgent().get(URL("not-an-id", "from=2099-01-01&to=2099-02-01"));
    expect(res.status).toBe(404);
  });

  test("is read-only: POST is not an availability route", async () => {
    const res = await createAgent().post(URL("64b0f0f0f0f0f0f0f0f0aaaa", "from=2099-01-01&to=2099-02-01"));
    expect([403, 404]).toContain(res.status);
  });
});

describe("detail page date picker", () => {
  test("renders the picker with the rules and a safe availability URL", async () => {
    const doc = new Listing(buildListingData({ minNights: 2, maxNights: 7 }));
    stubFindById(doc);
    const res = await createAgent().get(`/listings/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-date-picker");
    expect(res.text).toContain(`data-availability-url="/api/listings/${doc._id}/availability"`);
    expect(res.text).toContain('data-min-nights="2"');
    expect(res.text).toContain('data-max-nights="7"');
    expect(res.text).toContain('<script src="/js/date-picker.js"></script>');
    expect(res.text).toContain("Turn on JavaScript to choose dates.");
  });

  test("?in=&out= prefill only real dates; hostile values are dropped", async () => {
    const doc = new Listing(buildListingData());
    stubFindById(doc);
    const ok = await createAgent().get(`/listings/${doc._id}?in=${text(5)}&out=${text(8)}`);
    expect(ok.text).toContain(`data-initial-in="${text(5)}"`);
    expect(ok.text).toContain(`data-initial-out="${text(8)}"`);

    const bad = await createAgent().get(`/listings/${doc._id}?in="><script>alert(1)</script>&out=2099-02-30`);
    expect(bad.text).toContain('data-initial-in=""');
    expect(bad.text).toContain('data-initial-out=""');
    expect(bad.text).not.toContain("<script>alert(1)</script>");
  });
});

