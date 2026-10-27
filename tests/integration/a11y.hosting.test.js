// P18-T03: axe-core on the listing wizard, the edit page and the host's own
// listing pages, with view models built by the real services from real
// (unsaved) Listing documents. No database. Colour contrast: see contrast.test.js.
const {
  renderPage,
  audit,
  describe: show,
  member,
} = require("../helpers/a11y");
const Listing = require("../../src/models/listing");
const { buildListingData } = require("../helpers/factories");
const wizard = require("../../src/services/wizard");
const { evaluateReadiness } = require("../../src/services/readiness");
const { galleryOf, MAX_IMAGES } = require("../../src/services/images");
const {
  PROPERTY_TYPES,
  ROOM_TYPES,
  VIBES,
  CANCELLATION_POLICIES,
  AMENITIES,
} = require("../../src/config/constants");

const LISTS = {
  PROPERTY_TYPES,
  ROOM_TYPES,
  VIBES,
  CANCELLATION_POLICIES,
  AMENITIES,
};
const clean = async (view, locals, options) => {
  const violations = await audit(await renderPage(view, locals, options));
  if (violations.length)
    throw new Error(
      `${view}: axe found ${violations.length} problem(s):\n${show(violations)}`,
    );
};
const draft = (extra = {}) =>
  new Listing(
    buildListingData({ status: "draft", owner: member._id, ...extra }),
  );

describe("axe: the listing wizard", () => {
  test.each([1, 2, 3, 4, 5, 6])(
    "step %i, and the first step unsaved",
    async (n) => {
      const listing = draft();
      const step = wizard.stepByNumber(n);
      const locals = {
        listing,
        step,
        steps: wizard.stepStatuses(listing),
        values: wizard.formValues(listing, n),
        errors: {},
        formError: undefined,
        lists: LISTS,
        photoList: n === 4 ? galleryOf(listing) : [],
        maxImages: MAX_IMAGES,
        readiness: n === wizard.REVIEW_STEP ? evaluateReadiness(listing) : null,
        pageTitle: `${step.title} (step ${n} of 6)`,
      };
      await clean("host/step.ejs", locals);
      if (n === 1) {
        await clean("host/step.ejs", {
          ...locals,
          listing: undefined,
          steps: wizard.STEPS.map((s) => ({
            ...s,
            complete: false,
            reachable: s.n === 1,
          })),
          values: {},
          draftToken: "tok-1",
        });
      }
    },
  );

  test("a step with errors", async () => {
    const listing = draft();
    const step = wizard.stepByNumber(1);
    await clean("host/step.ejs", {
      listing,
      step,
      steps: wizard.stepStatuses(listing),
      values: { title: "", description: "" },
      lists: LISTS,
      photoList: [],
      maxImages: MAX_IMAGES,
      readiness: null,
      errors: { title: "Enter a title.", description: "Describe the place." },
      formError: "Please fix the problems below.",
      pageTitle: "The basics (step 1 of 6)",
    });
  });
});

describe("axe: listing forms and the host's listing pages", () => {
  test("create a listing (the older single form)", async () => {
    await clean("listings/new.ejs", { pageTitle: "List your place" });
  });

  test("edit a listing, and with a section refused", async () => {
    const listing = new Listing(
      buildListingData({ status: "published", owner: member._id }),
    );
    const sections = { basics: 1, location: 2, details: 3, pricing: 5 };
    const values = {};
    const errors = {};
    for (const [key, step] of Object.entries(sections)) {
      values[key] = wizard.formValues(listing, step);
      errors[key] = {};
    }
    const locals = {
      listing,
      values,
      errors,
      formError: undefined,
      failedKey: undefined,
      lists: LISTS,
      gallery: galleryOf(listing),
      maxImages: MAX_IMAGES,
      pageTitle: "Edit",
    };
    await clean("listings/edit.ejs", locals);
    await clean("listings/edit.ejs", {
      ...locals,
      formError: "Please fix the problems below.",
      failedKey: "pricing",
      errors: { ...errors, pricing: { price: "Enter a price." } },
    });
  });

  test("confirm the location", async () => {
    const listing = new Listing(
      buildListingData({ status: "published", owner: member._id }),
    );
    await clean("listings/confirm-location.ejs", {
      listing,
      address: {
        line1: "12 Beach Road",
        city: "Goa",
        state: "Goa",
        country: "India",
        postalCode: "403001",
      },
      placeName: "Beach Road, Candolim",
      pageTitle: "Confirm",
    });
    await clean("listings/confirm-location.ejs", {
      listing,
      address: { city: "Goa", country: "India" },
      placeName: "",
      pageTitle: "Confirm",
    });
  });

  test.each(["draft", "published", "unpublished", "suspended"])(
    "the %s status page",
    async (status) => {
      const listing = new Listing(
        buildListingData({ status, owner: member._id }),
      );
      if (status === "suspended")
        listing.set("moderation", { suspendReason: "Reported as a scam" });
      await clean("host/status.ejs", {
        listing,
        readiness: evaluateReadiness(listing),
        nearby: require("../../src/services/nearby").summaryFor(listing),
        pageTitle: "Status",
      });
    },
  );

  test("my listings, with rows and empty", async () => {
    const { loadHostListings } = require("../../src/services/hostListings");
    const docs = [
      new Listing(
        buildListingData({
          status: "published",
          title: "Sea house",
          owner: member._id,
        }),
      ),
      new Listing(
        buildListingData({
          status: "draft",
          title: "Half done",
          owner: member._id,
        }),
      ),
      new Listing(
        buildListingData({
          status: "suspended",
          title: "Taken down",
          owner: member._id,
        }),
      ),
    ];
    const chain = (rows) => {
      const q = {
        select: () => q,
        sort: () => q,
        limit: () => q,
        lean: async () => rows.map((d) => d.toObject()),
      };
      return q;
    };
    const full = await loadHostListings(
      { find: () => chain(docs) },
      member._id,
    );
    await clean("host/listings.ejs", {
      ...full,
      maxRows: 100,
      pageTitle: "My listings",
    });
    const none = await loadHostListings({ find: () => chain([]) }, member._id);
    await clean("host/listings.ejs", {
      ...none,
      maxRows: 100,
      pageTitle: "My listings",
    });
  });
});

describe("axe: calendar, saved stays, comparison and checkout", () => {
  const NOW = new Date("2026-10-20T06:00:00Z");
  const day = (s) => new Date(`${s}T00:00:00Z`);

  test("a listing's availability calendar, with blocked, requested and reserved nights", async () => {
    const {
      createAvailabilityService,
    } = require("../../src/services/availability");
    const listing = new Listing(
      buildListingData({ status: "published", owner: member._id }),
    );
    const rows = [
      {
        date: day("2026-11-03"),
        source: { kind: "block", id: "b1" },
        note: "Repairs",
      },
      { date: day("2026-11-10"), source: { kind: "reservation", id: "r1" } },
      {
        date: day("2026-11-12"),
        source: { kind: "reservation", id: "r2" },
        holdExpiresAt: new Date("2026-10-21T00:00:00Z"),
      },
    ];
    const service = createAvailabilityService({
      ledger: { nightsInRange: async () => rows },
    });
    const month = await service.monthView(listing, "2026-11", { now: NOW });
    await clean("host/calendar.ejs", {
      listing,
      calendar: month,
      errors: {},
      values: {},
      runs: [
        {
          fromIso: "2026-11-03",
          throughIso: "2026-11-04",
          fromLabel: "3 Nov",
          throughLabel: "4 Nov",
          nightsLabel: "2 nights",
          note: "Repairs",
          monthKey: "2026-11",
        },
      ],
      noteMaxLength: 200,
      truncated: false,
      pageTitle: "Availability",
    });
    await clean("host/calendar.ejs", {
      listing,
      calendar: month,
      errors: { block: "Choose a first night.", unblock: "Choose a night." },
      values: { from: "", through: "", note: "x" },
      runs: [],
      noteMaxLength: 200,
      truncated: false,
      pageTitle: "Availability",
    });
  });

  test("comparison: with dates, without dates, with a stay that is gone, and blocked", async () => {
    const { compare } = require("../../src/services/compare");
    const { getQuote } = require("../../src/services/quoteService");
    const stay = (extra = {}) => ({
      _id: String(new (require("mongoose").Types.ObjectId)()),
      title: "Sea house",
      status: "published",
      location: "Goa",
      country: "India",
      pricing: {
        nightlyMinor: 500000,
        cleaningFeeMinor: 100000,
        currency: "INR",
      },
      capacity: { guests: 4, bedrooms: 2, beds: 3, bathrooms: 1 },
      amenities: ["wifi", "kitchen"],
      cancellationPolicy: "flexible",
      houseRules: "No parties",
      ratingAvg: 4.5,
      ratingCount: 10,
      minNights: 1,
      maxNights: 30,
      timezone: "Asia/Kolkata",
      ...extra,
    });
    const a = stay();
    const b = stay({
      title: "Hill cabin",
      amenities: ["wifi", "parking"],
      pricing: { nightlyMinor: 300000, cleaningFeeMinor: 0, currency: "INR" },
    });
    const deps = (listings) => ({
      Listing: {
        find: (f) => ({
          lean: async () =>
            listings.filter((l) => f._id.$in.includes(String(l._id))),
        }),
      },
      getQuote: (l, q, o) =>
        getQuote(l, q, {
          ...o,
          ledgerService: { unavailableDates: async () => [] },
        }),
      publicPointOf: () => null,
      distanceMeters: () => 0,
      LocationNotFoundError: class extends Error {},
      GeocoderUnavailableError: class extends Error {},
      lookupPlace: async () => null,
    });
    const next = new Date(Date.now() + 30 * 86400000);
    const iso = (n) =>
      new Date(next.getTime() + n * 86400000).toISOString().slice(0, 10);
    const withDates = await compare({
      query: { ids: `${a._id},${b._id}`, in: iso(0), out: iso(3), guests: "2" },
      deps: deps([a, b]),
    });
    await clean("compare/index.ejs", {
      ...withDates,
      pageTitle: "Compare stays",
    });
    const noDates = await compare({
      query: { ids: `${a._id},${b._id}` },
      deps: deps([a, b]),
    });
    await clean("compare/index.ejs", {
      ...noDates,
      pageTitle: "Compare stays",
    });
    const gone = await compare({
      query: { ids: `${a._id},${new (require("mongoose").Types.ObjectId)()}` },
      deps: deps([a]),
    });
    await clean("compare/index.ejs", { ...gone, pageTitle: "Compare stays" });
  });

  test("saved stays: items (one removed), and empty", async () => {
    const { toCardItem } = require("../../src/utils/listingCard");
    const l = new Listing(
      buildListingData({
        status: "published",
        title: "Sea house",
        owner: member._id,
      }),
    );
    const items = [
      {
        id: String(l._id),
        available: true,
        title: "Sea house",
        savedAt: NOW,
        card: toCardItem(l),
      },
      {
        id: "64b0f0f0f0f0f0f0f0f0abcd",
        available: false,
        title: "A stay that was removed",
        savedAt: NOW,
        card: null,
      },
    ];
    await clean("wishlists/index.ejs", {
      pageTitle: "Saved stays",
      items,
      availableCount: 1,
      limit: 100,
    });
    await clean("wishlists/index.ejs", {
      pageTitle: "Saved stays",
      items: [],
      availableCount: 0,
      limit: 100,
    });
  });

  test("checkout: an instant booking, a request, and after the price changed", async () => {
    const { buildCheckoutView } = require("../../src/services/checkout");
    const pricing = require("../../src/services/pricing");
    const { parseDateOnly } = require("../../src/utils/dates");
    const listing = {
      _id: "507f1f77bcf86cd799439011",
      title: "Sea house",
      address: { city: "Goa" },
      country: "India",
      pricing: {
        nightlyMinor: 250000,
        cleaningFeeMinor: 50000,
        currency: "INR",
      },
      images: [{ url: "https://img/x.jpg" }],
      instantBook: false,
      cancellationPolicy: "flexible",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      houseRules: "Quiet after 10 pm.",
    };
    const quote = pricing.quote({
      listing,
      checkIn: parseDateOnly("2026-12-01"),
      checkOut: parseDateOnly("2026-12-04"),
      guests: 2,
    });
    const payload = {
      in: "2026-12-01",
      out: "2026-12-04",
      guests: 2,
      bookable: true,
      problems: [],
      quote,
      expectedTotalMinor: quote.totalMinor,
    };
    const key = "k".repeat(16);
    await clean("checkout/show.ejs", {
      pageTitle: "Confirm",
      checkout: buildCheckoutView(listing, payload, { idempotencyKey: key }),
    });
    await clean("checkout/show.ejs", {
      pageTitle: "Confirm",
      checkout: buildCheckoutView({ ...listing, instantBook: true }, payload, {
        idempotencyKey: key,
      }),
    });
    await clean("checkout/show.ejs", {
      pageTitle: "Confirm",
      checkout: buildCheckoutView(listing, payload, {
        idempotencyKey: key,
        previousTotalMinor: quote.totalMinor - 1500,
        previousLines: "nights:100",
      }),
    });
  });
});
