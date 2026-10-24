// P08-T03: the checkout page through the real app and views, no database.
// Listing.findById, the ledger and (where a booking is made) the reservation
// service are replaced; login goes through the real /login form with passport
// stubbed. The quote -> checkout -> reservation chain at the end uses the real
// reservation service over in-memory fakes. The same chain on a real MongoDB is
// tests/integration/checkout.db.test.js.
const mongoose = require("mongoose");
const { createAgent, login } = require("../helpers/agent");
const { buildListingData } = require("../helpers/factories");
const {
  FakeReservationModel,
  FakeListingModel,
  FakeLedger,
  fakeId,
} = require("../helpers/fakeReservationDeps");
const Listing = require("../../src/models/listing");
const User = require("../../src/models/user");
const ledger = require("../../src/services/ledger");
const pricing = require("../../src/services/pricing");
const reservations = require("../../src/services/reservations");
const reviewService = require("../../src/services/reviews");
const { createReservationService } = reservations;
const { formatMoney } = require("../../src/utils/money");
const { cancellationText } = require("../../src/config/cancellationText");
const {
  ConflictError,
  PriceChangedError,
  ValidationError,
} = require("../../src/utils/errors");
const {
  todayIn,
  addDays,
  formatDateOnly,
  parseDateOnly,
} = require("../../src/utils/dates");

const text = (n) => formatDateOnly(addDays(todayIn(), n));
const IN = text(20);
const OUT = text(23);
const qs = (obj) => new URLSearchParams(obj).toString();

// passport is one global object: every createApp() adds its (de)serializer to
// the same stack and the first one that answers wins. So the stubs are
// installed before every app and all read the same `current.user`, instead of
// each test closing over its own user.
const current = { user: null };
beforeEach(() => {
  current.user = makeGuest();
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

const HOST_ID = new mongoose.Types.ObjectId();

function makeListing(extra = {}) {
  return new Listing(
    buildListingData({
      owner: HOST_ID,
      minNights: 1,
      maxNights: 14,
      capacity: { guests: 4 },
      instantBook: false,
      cancellationPolicy: "moderate",
      houseRules: "No parties after 10 pm.",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      ...extra,
    }),
  );
}

function makeGuest(extra = {}) {
  return new User({
    username: "guest_one",
    email: "guest@example.com",
    ...extra,
  });
}

/** Stubs the listing lookup and the ledger (no taken nights unless given). */
function stubWorld(doc, { taken = [] } = {}) {
  // Awaitable and chainable, like a mongoose query (the quote API selects fields).
  const query = {
    select: () => query,
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  jest.spyOn(Listing, "findById").mockReturnValue(query);
  // The listing page asks whether a signed-in viewer has a stay to review
  // (P12-T01): a database question, answered here.
  jest.spyOn(reviewService, "findReviewable").mockResolvedValue(null);
  jest.spyOn(ledger, "unavailableDates").mockResolvedValue(taken);
  return doc;
}

async function loggedInAgent(user = makeGuest()) {
  current.user = user;
  const agent = createAgent();
  await login(agent, {
    username: "guest_one",
    password: "irrelevant-password",
  });
  return { agent, user };
}

const URL = (doc, over = {}) =>
  `/listings/${doc._id}/checkout?${qs({ in: IN, out: OUT, guests: 2, ...over })}`;
const field = (html, name) => {
  const hit = new RegExp(
    `<input type="hidden" name="${name}" value="([^"]*)">`,
  ).exec(html);
  return hit ? hit[1] : null;
};
const flashOn = async (agent, path = "/listings") =>
  (await agent.get(path)).text;

function expectedQuote(doc, guests = 2) {
  return pricing.quote({
    listing: doc,
    checkIn: parseDateOnly(IN),
    checkOut: parseDateOnly(OUT),
    guests,
  });
}

describe("GET /listings/:id/checkout", () => {
  test("a visitor is sent to log in and comes back to the same checkout after logging in", async () => {
    const doc = stubWorld(makeListing());
    const agent = createAgent();
    const first = await agent.get(URL(doc));
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("/login");
    const csrf = /name="csrf-token" content="([^"]*)"/.exec(
      (await agent.get("/login")).text,
    )[1];
    const loggedIn = await agent
      .post("/login")
      .set("X-CSRF-Token", csrf)
      .type("form")
      .send({ username: "guest_one", password: "irrelevant-password" });
    expect(loggedIn.status).toBe(302);
    expect(loggedIn.headers.location).toBe(URL(doc));
  });

  test("shows the stay, the rules, the policy, the final breakdown and the total to confirm", async () => {
    const doc = stubWorld(makeListing({ title: "Sea House" }));
    const { agent } = await loggedInAgent();
    const res = await agent.get(URL(doc));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const quote = expectedQuote(doc);
    expect(res.text).toContain("Sea House");
    expect(res.text).toContain("3");
    expect(res.text).toContain("2 guests");
    expect(res.text).toMatch(/from 14:00/);
    expect(res.text).toMatch(/by 11:00/);
    expect(res.text).toContain("No parties after 10 pm.");
    expect(res.text).toContain(cancellationText("moderate"));
    expect(res.text).toContain("Moderate");
    // every line of the pricing service, and its total
    for (const line of quote.lines) {
      expect(res.text).toContain(formatMoney(line.amountMinor, quote.currency));
    }
    const total = /data-total>([\s\S]*?)<\/p>/.exec(res.text)[1];
    expect(total).toContain(formatMoney(quote.totalMinor, quote.currency));
    expect(field(res.text, "expectedTotalMinor")).toBe(
      String(quote.totalMinor),
    );
    expect(field(res.text, "in")).toBe(IN);
    expect(field(res.text, "out")).toBe(OUT);
    expect(field(res.text, "guests")).toBe("2");
    expect(field(res.text, "idempotencyKey")).toMatch(/^[0-9a-f]{32}$/);
    expect(field(res.text, "_csrf")).toBeTruthy();
    expect(res.text).toMatch(
      /<form[^>]*method="POST"[^>]*action="\/listings\/[0-9a-f]{24}\/checkout"/,
    );
  });

  test("says clearly that it is a simulation", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    const res = await agent.get(URL(doc));
    expect(res.text).toMatch(/data-simulation-banner/);
    expect(res.text).toMatch(/no card is charged/i);
    expect(res.text).not.toMatch(/card number|cvv|expiry/i);
  });

  test("explains host approval (24 h hold) or instant booking", async () => {
    const { agent } = await loggedInAgent();
    let doc = stubWorld(makeListing({ instantBook: false }));
    let res = await agent.get(URL(doc));
    expect(res.text).toContain('data-booking-mode="request"');
    expect(res.text).toMatch(/24 hours/);
    expect(res.text).toContain("Send request");

    doc = stubWorld(makeListing({ instantBook: true }));
    res = await agent.get(URL(doc));
    expect(res.text).toContain('data-booking-mode="instant"');
    expect(res.text).toContain("Confirm booking");
  });

  test("a listing without a policy says no refund is promised", async () => {
    const listing = makeListing();
    listing.cancellationPolicy = undefined; // the schema fills in a default at construction
    const doc = stubWorld(listing);
    const { agent } = await loggedInAgent();
    const res = await agent.get(URL(doc));
    expect(res.text).toContain(cancellationText(undefined));
  });

  test("every visit gets its own idempotency key", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    const a = field((await agent.get(URL(doc))).text, "idempotencyKey");
    const b = field((await agent.get(URL(doc))).text, "idempotencyKey");
    expect(a).not.toBe(b);
  });

  test("text from the listing is escaped", async () => {
    const doc = stubWorld(
      makeListing({
        title: "<script>alert(1)</script>",
        houseRules: "<img src=x onerror=alert(2)>",
      }),
    );
    const { agent } = await loggedInAgent();
    const res = await agent.get(URL(doc));
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).not.toContain("<img src=x onerror");
    expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test.each([
    ["no dates", {}, "in=&out=&guests=2"],
    ["a bad date", { in: "2026-13-45" }, null],
    ["guests of zero", { guests: 0 }, null],
  ])(
    "%s: back to the listing with a message, no checkout page",
    async (_name, over, raw) => {
      const doc = stubWorld(makeListing());
      const { agent } = await loggedInAgent();
      const res = await agent.get(
        raw ? `/listings/${doc._id}/checkout?${raw}` : URL(doc, over),
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${doc._id}`);
    },
  );

  test("a stay the rules refuse goes back to the listing with the reason", async () => {
    const doc = stubWorld(makeListing({ minNights: 5 }));
    const { agent } = await loggedInAgent();
    const res = await agent.get(URL(doc));
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(
      new RegExp(`^/listings/${doc._id}\\?guests=2$`),
    );
    expect(await flashOn(agent, res.headers.location)).toContain(
      "The minimum stay is 5 nights.",
    );
  });

  test("nights taken while the guest was on the listing page: back with the dates named", async () => {
    const doc = stubWorld(makeListing(), { taken: [parseDateOnly(text(21))] });
    const { agent } = await loggedInAgent();
    const res = await agent.get(URL(doc));
    expect(res.status).toBe(302);
    expect(await flashOn(agent, res.headers.location)).toContain(
      `These nights are not available: ${text(21)}.`,
    );
  });

  test("you cannot book your own listing (403) or an unpublished one (404)", async () => {
    const guest = makeGuest();
    const own = stubWorld(makeListing({ owner: guest._id }));
    const { agent } = await loggedInAgent(guest);
    expect((await agent.get(URL(own))).status).toBe(403);
    // (same account, still logged in)

    current.user = makeGuest();
    const draft = stubWorld(makeListing({ status: "unpublished" }));
    expect((await agent.get(URL(draft))).status).toBe(404);
  });

  test("a suspended guest cannot open it", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    // suspended after logging in: the next request sees the suspended account
    current.user = makeGuest({ status: "suspended" });
    const res = await agent.get(URL(doc));
    expect(res.status).toBe(403);
  });
});

describe("POST /listings/:id/checkout", () => {
  const body = (doc, over = {}) => ({
    in: IN,
    out: OUT,
    guests: "2",
    expectedTotalMinor: String(expectedQuote(doc).totalMinor),
    previousLines: "",
    idempotencyKey: "a1b2c3d4e5f60718a1b2c3d4e5f60718",
    ...over,
  });

  test("sends the stay, the confirmed total and the key to reservations.create, then goes to the listing with a reference", async () => {
    const doc = stubWorld(makeListing());
    const { agent, user } = await loggedInAgent();
    const id = new mongoose.Types.ObjectId();
    const create = jest
      .spyOn(reservations, "create")
      .mockResolvedValue({
        reservation: { _id: id, listing: doc._id, status: "pending" },
        created: true,
      });
    const res = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/listings/${doc._id}`);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual({
      guest: expect.objectContaining({ _id: user._id }),
      listing: doc._id,
      in: IN,
      out: OUT,
      guests: "2",
      expectedTotalMinor: String(expectedQuote(doc).totalMinor),
      idempotencyKey: "a1b2c3d4e5f60718a1b2c3d4e5f60718",
    });
    const page = await flashOn(agent, res.headers.location);
    expect(page).toContain(
      `Your reference is ${String(id).slice(-8).toUpperCase()}`,
    );
    expect(page).toContain("sent to the host");
  });

  test("an instant booking says it is booked", async () => {
    const doc = stubWorld(makeListing({ instantBook: true }));
    const { agent } = await loggedInAgent();
    jest.spyOn(reservations, "create").mockResolvedValue({
      reservation: {
        _id: new mongoose.Types.ObjectId(),
        listing: doc._id,
        status: "confirmed",
      },
      created: true,
    });
    const res = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    expect(await flashOn(agent, res.headers.location)).toContain(
      "You are booked.",
    );
  });

  test("the browser cannot book without the total it is confirming", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    const create = jest.spyOn(reservations, "create");
    for (const bad of ["", "abc", "-5", "12.5", "1e9"]) {
      const res = await agent
        .post(`/listings/${doc._id}/checkout`)
        .type("form")
        .send(body(doc, { expectedTotalMinor: bad }));
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${doc._id}`);
    }
    const missing = body(doc);
    delete missing.expectedTotalMinor;
    await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(missing);
    expect(create).not.toHaveBeenCalled();
  });

  test("a price that changed: nothing is booked, the page is shown again with the differences highlighted and a box to tick", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    const quote = expectedQuote(doc);
    const create = jest
      .spyOn(reservations, "create")
      .mockRejectedValue(new PriceChangedError(quote));
    const before = quote.lines
      .map((l) => `${l.code}:${l.amountMinor}`)
      .join(";");
    const staleTotal = quote.totalMinor - 100000;
    // the guest saw a nightly line that was 1000 rupees cheaper
    const previousLines = before.replace(
      /^nights:\d+/,
      `nights:${quote.lines[0].amountMinor - 100000}`,
    );
    const res = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(
        body(doc, { expectedTotalMinor: String(staleTotal), previousLines }),
      );
    expect(res.status).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
    expect(res.text).toContain("data-price-changed");
    expect(res.text).toContain(formatMoney(staleTotal, quote.currency));
    expect(res.text).toContain(formatMoney(quote.totalMinor, quote.currency));
    expect(res.text).toMatch(/1,000 more/);
    // the changed line is marked in words, not only by colour
    expect(res.text).toMatch(
      /<li class="quote-line-changed" data-changed>[\s\S]*?changed/,
    );
    // reconfirmation is required and the new total is what will be confirmed
    expect(res.text).toMatch(/<input[^>]*id="confirm-change"[^>]*required/);
    expect(field(res.text, "expectedTotalMinor")).toBe(
      String(quote.totalMinor),
    );
    // the same key stays: nothing was created under it
    expect(field(res.text, "idempotencyKey")).toBe(
      "a1b2c3d4e5f60718a1b2c3d4e5f60718",
    );
  });

  test("a price that went DOWN is described as less", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    const quote = expectedQuote(doc);
    jest
      .spyOn(reservations, "create")
      .mockRejectedValue(new PriceChangedError(quote));
    const res = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(
        body(doc, { expectedTotalMinor: String(quote.totalMinor + 50000) }),
      );
    expect(res.status).toBe(409);
    expect(res.text).toMatch(/500 less/);
  });

  test("nights taken meanwhile: back to the listing with a message, no booking", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    jest
      .spyOn(reservations, "create")
      .mockRejectedValue(
        new ConflictError("These nights are not available.", {
          code: "nights_unavailable",
        }),
      );
    const res = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/listings/${doc._id}?guests=2`);
    expect(await flashOn(agent, res.headers.location)).toContain(
      "Some of those nights were just taken",
    );
  });

  test("a booking rule that changed meanwhile shows its own message; other validation errors are a 400", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    const create = jest
      .spyOn(reservations, "create")
      .mockRejectedValueOnce(
        new ValidationError("The minimum stay is 5 nights.", {
          code: "below_min_nights",
        }),
      );
    const first = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    expect(first.status).toBe(302);
    expect(await flashOn(agent, first.headers.location)).toContain(
      "The minimum stay is 5 nights.",
    );

    create.mockRejectedValueOnce(
      new ValidationError("A booking needs an idempotency key."),
    );
    const second = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    expect(second.status).toBe(400);
  });

  test("a reused key for a different stay sends the guest back to a fresh checkout", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    jest
      .spyOn(reservations, "create")
      .mockRejectedValue(
        new ConflictError("That booking key was already used.", {
          code: "idempotency_key_reused",
        }),
      );
    const res = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      URL(doc, { guests: "2" }).replace(/guests=2$/, "guests=2"),
    );
  });

  test("a double click that reservations.create answers twice with the same booking gives the same result", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    const reservation = {
      _id: new mongoose.Types.ObjectId(),
      listing: doc._id,
      status: "pending",
    };
    jest
      .spyOn(reservations, "create")
      .mockResolvedValueOnce({ reservation, created: true })
      .mockResolvedValueOnce({ reservation, created: false });
    const a = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    const b = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    expect(a.headers.location).toBe(b.headers.location);
  });

  test("a visitor who is not logged in is asked to log in, and nothing is created", async () => {
    const doc = stubWorld(makeListing());
    const create = jest.spyOn(reservations, "create");
    const res = await createAgent()
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(body(doc));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("a session that ended while the guest was on the checkout page", () => {
  const ID = new mongoose.Types.ObjectId().toString();
  const post = (params) =>
    createAgent({ csrf: false })
      .post(`/listings/${ID}/checkout`)
      .set("X-CSRF-Token", "token-of-the-old-session")
      .type("form")
      .send(params);

  test("is not a dead-end 403: the guest goes back to the checkout for the same stay", async () => {
    const create = jest.spyOn(reservations, "create");
    const res = await post({
      in: IN,
      out: OUT,
      guests: "2",
      expectedTotalMinor: "100",
      idempotencyKey: "k".repeat(16),
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `/listings/${ID}/checkout?${qs({ in: IN, out: OUT, guests: "2" })}`,
    );
    expect(create).not.toHaveBeenCalled();
  });

  test("the redirect is built only from checked values", async () => {
    const res = await post({
      in: "javascript:alert(1)",
      out: OUT,
      guests: "2",
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/listings/${ID}/checkout`);
    const res2 = await post({ in: IN, out: OUT, guests: "2&next=//evil.com" });
    expect(res2.headers.location).toBe(`/listings/${ID}/checkout`);
  });

  test("a page whose id is not a listing id keeps the normal 403, and other routes are untouched", async () => {
    const bad = await createAgent({ csrf: false })
      .post("/listings/not-an-id/checkout")
      .set("X-CSRF-Token", "x")
      .type("form")
      .send({});
    expect(bad.status).toBe(403);
    const other = await createAgent({ csrf: false })
      .post(`/listings/${ID}/checkout/extra`)
      .set("X-CSRF-Token", "x")
      .type("form")
      .send({});
    expect(other.status).toBe(403);
    const logout = await createAgent({ csrf: false })
      .post("/logout")
      .set("X-CSRF-Token", "x");
    expect(logout.status).toBe(403);
  });

  test("a GET with a fresh login would then show the page (the link ends at the login redirect)", async () => {
    const res = await createAgent().get(
      `/listings/${ID}/checkout?${qs({ in: IN, out: OUT, guests: "2" })}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });
});

describe("quote -> checkout -> reservation: the stored total is the quoted total", () => {
  test("for a host-approval listing and for an instant one", async () => {
    for (const instantBook of [false, true]) {
      const doc = stubWorld(makeListing({ instantBook }));
      const { agent, user } = await loggedInAgent();

      // 1. the quote API (what the booking panel shows)
      const quoteRes = await agent.get(
        `/api/listings/${doc._id}/quote?${qs({ in: IN, out: OUT, guests: 2 })}`,
      );
      expect(quoteRes.body.bookable).toBe(true);
      const quoted = quoteRes.body.quote.totalMinor;

      // 2. the checkout page: same total shown and confirmed
      const page = (await agent.get(URL(doc))).text;
      expect(field(page, "expectedTotalMinor")).toBe(String(quoted));
      expect(/data-total>([\s\S]*?)<\/p>/.exec(page)[1]).toContain(
        formatMoney(quoted, "INR"),
      );

      // 3. submit the form exactly as the browser would, with the real
      //    reservation service over in-memory fakes
      const Reservation = new FakeReservationModel();
      const fakeLedger = new FakeLedger();
      const service = createReservationService({
        ReservationModel: Reservation,
        ListingModel: new FakeListingModel([doc]),
        ledgerService: fakeLedger,
        pricing,
        newId: fakeId,
      });
      jest
        .spyOn(reservations, "create")
        .mockImplementation((input, opts) => service.create(input, opts));
      const form = {
        in: field(page, "in"),
        out: field(page, "out"),
        guests: field(page, "guests"),
        expectedTotalMinor: field(page, "expectedTotalMinor"),
        previousLines: field(page, "previousLines"),
        idempotencyKey: field(page, "idempotencyKey"),
      };
      const res = await agent
        .post(`/listings/${doc._id}/checkout`)
        .type("form")
        .send(form);
      expect(res.status).toBe(302);

      expect(Reservation.docs).toHaveLength(1);
      const stored = Reservation.docs[0];
      expect(stored.pricingSnapshot.totalMinor).toBe(quoted);
      expect(stored.status).toBe(instantBook ? "confirmed" : "pending");
      expect(String(stored.guest)).toBe(String(user._id));
      expect(fakeLedger.rows).toHaveLength(3);

      // 4. pressing the button twice (same form, same key) books once
      const again = await agent
        .post(`/listings/${doc._id}/checkout`)
        .type("form")
        .send(form);
      expect(again.status).toBe(302);
      expect(Reservation.docs).toHaveLength(1);
      expect(fakeLedger.rows).toHaveLength(3);
    }
  });

  test("when the host changes the price between the page and the click, the guest must confirm again, then it books at the new total", async () => {
    const doc = stubWorld(makeListing());
    const { agent } = await loggedInAgent();
    const page = (await agent.get(URL(doc))).text;
    const oldTotal = Number(field(page, "expectedTotalMinor"));

    // the host raises the nightly price after the page was drawn
    doc.pricing.nightlyMinor += 100000;

    const Reservation = new FakeReservationModel();
    const fakeLedger = new FakeLedger();
    const service = createReservationService({
      ReservationModel: Reservation,
      ListingModel: new FakeListingModel([doc]),
      ledgerService: fakeLedger,
      pricing,
      newId: fakeId,
    });
    jest
      .spyOn(reservations, "create")
      .mockImplementation((input, opts) => service.create(input, opts));
    const form = {
      in: field(page, "in"),
      out: field(page, "out"),
      guests: field(page, "guests"),
      expectedTotalMinor: String(oldTotal),
      previousLines: field(page, "previousLines"),
      idempotencyKey: field(page, "idempotencyKey"),
    };

    const refused = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send(form);
    expect(refused.status).toBe(409);
    expect(Reservation.docs).toHaveLength(0);
    expect(fakeLedger.rows).toHaveLength(0);
    const newTotal = Number(field(refused.text, "expectedTotalMinor"));
    expect(newTotal).toBeGreaterThan(oldTotal);
    expect(refused.text).toContain("data-changed");

    const confirmed = await agent
      .post(`/listings/${doc._id}/checkout`)
      .type("form")
      .send({
        ...form,
        expectedTotalMinor: String(newTotal),
        previousLines: field(refused.text, "previousLines"),
        confirmChange: "yes",
      });
    expect(confirmed.status).toBe(302);
    expect(Reservation.docs).toHaveLength(1);
    expect(Reservation.docs[0].pricingSnapshot.totalMinor).toBe(newTotal);
  });
});
