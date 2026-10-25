// P08-T02: GET /api/listings/:id/quote through the real app, no database.
const { createAgent } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const ledger = require("../../src/services/ledger");
const pricing = require("../../src/services/pricing");
const {
  todayIn,
  addDays,
  formatDateOnly,
  parseDateOnly,
} = require("../../src/utils/dates");

const text = (n) => formatDateOnly(addDays(todayIn(), n));

function stubFindById(doc) {
  const query = {
    select: () => query,
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}
afterEach(() => jest.restoreAllMocks());

const URL = (id, qs) => `/api/listings/${id}/quote?${qs}`;
const stay = (over = {}) => ({
  in: text(20),
  out: text(23),
  guests: 2,
  ...over,
});
const qs = (obj) => new URLSearchParams(obj).toString();
const makeDoc = (extra = {}) =>
  new Listing(buildListingData({ minNights: 1, maxNights: 14, ...extra }));

describe("quote API", () => {
  test("equals the pricing service's output, uncached JSON, with the total to confirm", async () => {
    const doc = makeDoc();
    stubFindById(doc);
    const spy = jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const s = stay();
    const res = await createAgent().get(URL(doc._id, qs(s)));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const expected = pricing.quote({
      listing: doc,
      checkIn: parseDateOnly(s.in),
      checkOut: parseDateOnly(s.out),
      guests: 2,
    });
    expect(res.body.bookable).toBe(true);
    expect(res.body.problems).toEqual([]);
    expect(res.body.quote).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(res.body.expectedTotalMinor).toBe(expected.totalMinor);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("taken nights give reasons (dates only) and no price", async () => {
    const doc = makeDoc();
    stubFindById(doc);
    jest
      .spyOn(ledger, "unavailableDates")
      .mockResolvedValue([parseDateOnly(text(21))]);
    // no free stretch anywhere nearby: the answer says so (P15-T04)
    jest.spyOn(ledger, "availableRanges").mockResolvedValue([]);
    const res = await createAgent().get(URL(doc._id, qs(stay())));
    expect(res.status).toBe(200);
    expect(res.body.bookable).toBe(false);
    expect(res.body.quote).toBeNull();
    expect(res.body.alternatives).toEqual({ radiusDays: 14, windows: [] });
    expect(res.body.problems).toEqual([
      {
        code: "nights_unavailable",
        message: `These nights are not available: ${text(21)}.`,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /source|reservation|block|owner|user/i,
    );
  });

  test("taken nights also return the nearest free stays of the same length, each priced by the quote service (P15-T04)", async () => {
    const doc = makeDoc();
    stubFindById(doc);
    const requestedIn = parseDateOnly(text(20));
    const free = { from: parseDateOnly(text(24)), to: parseDateOnly(text(30)), nights: 6 };
    jest.spyOn(ledger, "availableRanges").mockResolvedValue([free]);
    // the requested stay is taken; every suggested stay is free when it is checked
    jest.spyOn(ledger, "unavailableDates").mockImplementation(async (id, from) =>
      from.getTime() === requestedIn.getTime() ? [parseDateOnly(text(21))] : [],
    );
    const res = await createAgent().get(URL(doc._id, qs(stay())));
    expect(res.status).toBe(200);
    expect(res.body.bookable).toBe(false);
    const { windows, radiusDays } = res.body.alternatives;
    expect(radiusDays).toBe(14);
    expect(windows.map((w) => [w.in, w.out, w.nights, w.shiftDays])).toEqual([
      [text(24), text(27), 3, 4],
      [text(27), text(30), 3, 7],
    ]);
    for (const w of windows) {
      const expected = pricing.quote({
        listing: doc,
        checkIn: parseDateOnly(w.in),
        checkOut: parseDateOnly(w.out),
        guests: 2,
      });
      expect(w.quote).toEqual(JSON.parse(JSON.stringify(expected)));
    }
  });

  test("a stay that is bookable, or refused by a rule, carries no alternatives", async () => {
    const doc = makeDoc({ minNights: 5 });
    stubFindById(doc);
    let ranges = jest.spyOn(ledger, "availableRanges");
    jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const rule = await createAgent().get(URL(doc._id, qs(stay())));
    expect(rule.body.alternatives).toBeUndefined();
    expect(ranges).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    stubFindById(makeDoc());
    ranges = jest.spyOn(ledger, "availableRanges");
    jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const ok = await createAgent().get(URL(doc._id, qs(stay())));
    expect(ok.body.bookable).toBe(true);
    expect(ok.body.alternatives).toBeUndefined();
    expect(ranges).not.toHaveBeenCalled();
  });

  test("a rule problem (minimum stay) is a 200 with its reason", async () => {
    const doc = makeDoc({ minNights: 5 });
    stubFindById(doc);
    jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const res = await createAgent().get(URL(doc._id, qs(stay())));
    expect(res.status).toBe(200);
    expect(res.body.problems[0]).toEqual({
      code: "below_min_nights",
      message: "The minimum stay is 5 nights.",
    });
  });

  test.each([
    ["missing everything", "", ["guests", "in", "out"]],
    ["bad date", "in=2026-02-30&out=2026-03-04&guests=2", ["in"]],
    [
      "check-out not after check-in",
      `in=${text(20)}&out=${text(20)}&guests=2`,
      ["out"],
    ],
    ["reversed", `in=${text(23)}&out=${text(20)}&guests=2`, ["out"]],
    ["bad guests", `in=${text(20)}&out=${text(23)}&guests=0`, ["guests"]],
    [
      "repeated parameter",
      `in=${text(20)}&in=${text(21)}&out=${text(23)}&guests=2`,
      ["in"],
    ],
    [
      "floating guests",
      `in=${text(20)}&out=${text(23)}&guests=1.5`,
      ["guests"],
    ],
  ])("400 JSON with field messages: %s", async (_name, query, names) => {
    const doc = makeDoc();
    stubFindById(doc);
    const spy = jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const res = await createAgent().get(URL(doc._id, query));
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(
      [...names].sort(),
    );
    for (const message of Object.values(res.body.error.fields))
      expect(typeof message).toBe("string");
    expect(spy).not.toHaveBeenCalled();
  });

  test("a listing with no valid price is a 422", async () => {
    const doc = makeDoc();
    doc.set("pricing.nightlyMinor", undefined);
    stubFindById(doc);
    jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const res = await createAgent().get(URL(doc._id, qs(stay())));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("quote_refused");
  });

  test.each([
    ["unknown", null, {}],
    ["draft", undefined, { status: "draft" }],
    ["unpublished", undefined, { status: "unpublished" }],
    ["deleted", undefined, { deletedAt: new Date() }],
  ])(
    "404 JSON for a listing that is %s (anonymous)",
    async (_name, doc, extra) => {
      const found = doc === null ? null : makeDoc(extra);
      if (found) found.set(extra);
      stubFindById(found);
      const spy = jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
      const res = await createAgent().get(
        URL("64b0f0f0f0f0f0f0f0f0aaaa", qs(stay())),
      );
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  test("a malformed id is a 404, not a 500", async () => {
    const res = await createAgent().get(URL("not-an-id", qs(stay())));
    expect(res.status).toBe(404);
  });

  test("it is rate limited: the 61st request in a minute is a 429 JSON error", async () => {
    const doc = makeDoc();
    stubFindById(doc);
    jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    const agent = createAgent();
    for (let i = 0; i < 60; i += 1) {
      const ok = await agent.get(URL(doc._id, qs(stay())));
      expect(ok.status).toBe(200);
    }
    const res = await agent.get(URL(doc._id, qs(stay())));
    expect(res.status).toBe(429);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error.code).toBe("rate_limited");
  });

  test("it is read-only: POST is not a quote route", async () => {
    const res = await createAgent().post(
      URL("64b0f0f0f0f0f0f0f0f0aaaa", qs(stay())),
    );
    expect([403, 404]).toContain(res.status);
  });
});

describe("detail page booking panel", () => {
  test("renders guests (up to the capacity), the live region, a disabled Reserve and the script", async () => {
    const doc = makeDoc({
      capacity: { guests: 3, bedrooms: 1, beds: 1, bathrooms: 1 },
    });
    stubFindById(doc);
    const res = await createAgent().get(
      `/listings/${doc._id}?guests=9&in=${text(20)}&out=${text(23)}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-booking-panel");
    expect(res.text).toContain(
      `data-quote-url="/api/listings/${doc._id}/quote"`,
    );
    expect(res.text).toMatch(/<select id="quote-guests"/);
    expect(res.text).toContain('<option value="3" selected>3 guests</option>');
    expect(res.text).not.toContain('<option value="4"');
    expect(res.text).toContain('aria-live="polite"');
    expect(res.text).toMatch(
      /<a class="btn btn-dark w-100 mt-3 disabled"[^>]*aria-disabled="true"[^>]*data-reserve>Reserve<\/a>/,
    );
    expect(res.text).toContain('<script src="/js/booking-panel.js"></script>');
    expect(res.text).not.toContain("Online booking is not open yet.");
  });
});
