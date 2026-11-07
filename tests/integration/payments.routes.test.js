// P16-T01: GET/POST /trips/:id/pay and the checkout hand-over, through the real
// app and views, no database. Reservation.findById and the payment service are
// replaced; login goes through the real /login form with passport stubbed (the
// same pattern as checkout.test.js). The service itself is
// tests/unit/payments.service.test.js; the unique rules on a real MongoDB are
// tests/integration/payments.db.test.js.
const mongoose = require("mongoose");
const { createAgent, login } = require("../helpers/agent");
const { testConfig } = require("../helpers/config");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const User = require("../../src/models/user");
const Reservation = require("../../src/models/reservation");
const ledger = require("../../src/services/ledger");
const pricing = require("../../src/services/pricing");
const reservations = require("../../src/services/reservations");
const reviewService = require("../../src/services/reviews");
const payments = require("../../src/services/payments");
const { ConflictError, ValidationError } = require("../../src/utils/errors");
const { todayIn, addDays, formatDateOnly, parseDateOnly } = require("../../src/utils/dates");

const ON = { simulated: true, outcomeSelector: false, holdMinutes: 15 };
const withPayments = (payments_) => ({ config: testConfig({ payments: payments_ }) });
const KEY = "a1b2c3d4e5f60718a1b2c3d4e5f60718";

const current = { user: null };
const makeGuest = () => new User({ username: "guest_one", email: "guest@example.com" });
beforeEach(() => {
  current.user = makeGuest();
  jest.spyOn(User, "authenticate").mockReturnValue((u, p, done) => done(null, current.user));
  jest.spyOn(User, "serializeUser").mockReturnValue((u, done) => done(null, String(u._id)));
  jest.spyOn(User, "deserializeUser").mockReturnValue((id, done) => done(null, current.user));
});
afterEach(() => jest.restoreAllMocks());

async function loggedIn(options = withPayments(ON)) {
  const agent = createAgent(options);
  await login(agent, { username: "guest_one", password: "irrelevant-password" });
  return agent;
}

function waiting(over = {}) {
  const id = new mongoose.Types.ObjectId();
  return {
    _id: id,
    guest: current.user._id,
    host: new mongoose.Types.ObjectId(),
    status: "awaiting_payment",
    holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    checkIn: parseDateOnly("2027-03-10"),
    checkOut: parseDateOnly("2027-03-13"),
    nights: 3,
    guests: 2,
    pricingSnapshot: { totalMinor: 985600, currency: "INR" },
    listingSnapshot: { title: "Sea house", city: "Goa", timezone: "Asia/Kolkata", instantBook: false },
    ...over,
  };
}
const stubFind = (doc) => jest.spyOn(Reservation, "findById").mockResolvedValue(doc);
const flashOn = async (agent, path) => (await agent.get(path)).text;

describe("GET /trips/:id/pay", () => {
  test("a visitor is sent to log in", async () => {
    const res = await createAgent(withPayments(ON)).get(`/trips/${new mongoose.Types.ObjectId()}/pay`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  test("the guest sees a TEST MODE page with the amount, the time left and a key; no card field of any kind", async () => {
    const doc = waiting();
    stubFind(doc);
    const agent = await loggedIn();
    const res = await agent.get(`/trips/${doc._id}/pay`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("TEST MODE: no money moves");
    expect(res.text).toContain("Pay (simulated)");
    expect(res.text).toContain("data-test-mode-banner");
    expect(res.text.replace(/\u00a0/g, " ")).toContain("₹9,856");
    expect(res.text).toMatch(/name="idempotencyKey" value="[0-9a-f]{32}"/);
    expect(res.text).toMatch(/name="_csrf"/);
    expect(res.text).not.toMatch(/name="(card|cc|cvv|cvc|expiry|exp|pan)[^"]*"/i);
    expect(res.text).not.toMatch(/autocomplete="cc-/i);
    expect(res.text).not.toMatch(/type="password"/i);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  test("the developer outcome selector appears only when it is switched on", async () => {
    const doc = waiting();
    stubFind(doc);
    const off = await (await loggedIn()).get(`/trips/${doc._id}/pay`);
    expect(off.text).not.toContain("data-outcome-selector");
    const on = await (await loggedIn(withPayments({ ...ON, outcomeSelector: true }))).get(`/trips/${doc._id}/pay`);
    expect(on.text).toContain("data-outcome-selector");
    for (const value of ["success", "declined", "error"]) expect(on.text).toContain(`value="${value}"`);
  });

  test("someone else's booking, a booking that does not exist and an id that is not an id are all the same 404", async () => {
    const agent = await loggedIn();
    const spy = stubFind(waiting({ guest: new mongoose.Types.ObjectId() }));
    const someoneElses = await agent.get(`/trips/${new mongoose.Types.ObjectId()}/pay`);
    expect(someoneElses.status).toBe(404);
    spy.mockResolvedValue(null);
    expect((await agent.get(`/trips/${new mongoose.Types.ObjectId()}/pay`)).status).toBe(404);
    expect((await agent.get("/trips/not-an-id/pay")).status).toBe(404);
    expect(someoneElses.text).not.toContain("TEST MODE");
  });

  test("a booking that is not waiting any more goes to its booking page", async () => {
    const doc = waiting({ status: "confirmed", holdExpiresAt: undefined });
    stubFind(doc);
    const res = await (await loggedIn()).get(`/trips/${doc._id}/pay`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/trips/${doc._id}`);
  });

  test("after the hold the page is not shown: the booking page says the time ran out", async () => {
    const doc = waiting({ holdExpiresAt: new Date(Date.now() - 1000) });
    stubFind(doc);
    const agent = await loggedIn();
    const res = await agent.get(`/trips/${doc._id}/pay`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/trips/${doc._id}`);
    expect(await flashOn(agent, "/about")).toContain("time to pay for this booking has run out");
  });
});

describe("POST /trips/:id/pay", () => {
  const paid = { ok: true, status: "paid" };

  test("a success goes to the booking page and says nothing was moved; the service gets the guest, the key and 'success'", async () => {
    const doc = waiting();
    stubFind(doc);
    const pay = jest.spyOn(payments, "pay").mockResolvedValue(paid);
    const agent = await loggedIn();
    const res = await agent.post(`/trips/${doc._id}/pay`).type("form").send({ idempotencyKey: KEY });
    expect(res.status).toBe(302);
    expect(pay).toHaveBeenCalledTimes(1);
    const arg = pay.mock.calls[0][0];
    expect(arg).toMatchObject({ idempotencyKey: KEY, outcome: "success" });
    expect(String(arg.guest._id)).toBe(String(current.user._id));
    const page = await flashOn(agent, "/about");
    expect(page).toContain("Payment received (simulated: no money moved)");
    expect(page).toContain("sent to the host"); // request-to-book listing
  });

  test("an instant-book booking says it is booked", async () => {
    const doc = waiting({ listingSnapshot: { title: "x", instantBook: true } });
    stubFind(doc);
    jest.spyOn(payments, "pay").mockResolvedValue(paid);
    const agent = await loggedIn();
    const res = await agent.post(`/trips/${doc._id}/pay`).type("form").send({ idempotencyKey: KEY });
    expect(res.status).toBe(302);
    expect(await flashOn(agent, "/about")).toContain("You are booked");
  });

  test("the browser cannot pick an outcome unless the selector is on", async () => {
    const doc = waiting();
    stubFind(doc);
    const pay = jest.spyOn(payments, "pay").mockResolvedValue(paid);
    await (await loggedIn()).post(`/trips/${doc._id}/pay`).type("form").send({ idempotencyKey: KEY, outcome: "declined" });
    expect(pay.mock.calls[0][0].outcome).toBe("success");
    await (await loggedIn(withPayments({ ...ON, outcomeSelector: true })))
      .post(`/trips/${doc._id}/pay`)
      .type("form")
      .send({ idempotencyKey: KEY, outcome: "declined" });
    expect(pay.mock.calls[1][0].outcome).toBe("declined");
    await (await loggedIn(withPayments({ ...ON, outcomeSelector: true })))
      .post(`/trips/${doc._id}/pay`)
      .type("form")
      .send({ idempotencyKey: KEY, outcome: "free-money" });
    expect(pay.mock.calls[2][0].outcome).toBe("success");
  });

  test("a refusal goes back to the pay page and says nothing was charged and the dates stay held", async () => {
    const doc = waiting();
    stubFind(doc);
    jest.spyOn(payments, "pay").mockResolvedValue({
      ok: false,
      status: "failed",
      failureCode: "declined",
      message: "The simulated payment was declined.",
    });
    const agent = await loggedIn();
    const res = await agent.post(`/trips/${doc._id}/pay`).type("form").send({ idempotencyKey: KEY });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/trips/${doc._id}/pay`);
    const page = await flashOn(agent, "/about");
    expect(page).toContain("was declined");
    expect(page).toContain("Nothing was charged");
    expect(page).toContain("dates stay held until");
  });

  test("a hold that ran out meanwhile goes to the booking page", async () => {
    const doc = waiting();
    stubFind(doc);
    jest.spyOn(payments, "pay").mockResolvedValue({
      ok: false,
      status: "failed",
      failureCode: "hold_expired",
      message: "The time to pay for this booking ran out.",
    });
    const res = await (await loggedIn()).post(`/trips/${doc._id}/pay`).type("form").send({ idempotencyKey: KEY });
    expect(res.headers.location).toBe(`/trips/${doc._id}`);
  });

  test("a payment that is already running says so and stays on the pay page", async () => {
    const doc = waiting();
    stubFind(doc);
    jest.spyOn(payments, "pay").mockResolvedValue({
      ok: false,
      status: "in_progress",
      message: "A payment for this booking is already being processed.",
    });
    const agent = await loggedIn();
    const res = await agent.post(`/trips/${doc._id}/pay`).type("form").send({ idempotencyKey: KEY });
    expect(res.headers.location).toBe(`/trips/${doc._id}/pay`);
    expect(await flashOn(agent, "/about")).toContain("already being processed");
  });

  test("a conflict from the service (no longer waiting) goes to the booking page with its message", async () => {
    const doc = waiting();
    stubFind(doc);
    jest.spyOn(payments, "pay").mockRejectedValue(new ConflictError("This booking is no longer waiting for payment.", { code: "not_awaiting_payment" }));
    const agent = await loggedIn();
    const res = await agent.post(`/trips/${doc._id}/pay`).type("form").send({ idempotencyKey: KEY });
    expect(res.headers.location).toBe(`/trips/${doc._id}`);
    expect(await flashOn(agent, "/about")).toContain("no longer waiting for payment");
  });

  test("a missing or malformed key is sent back to a fresh pay page", async () => {
    const doc = waiting();
    stubFind(doc);
    jest.spyOn(payments, "pay").mockRejectedValue(new ValidationError("A payment needs a key."));
    const res = await (await loggedIn()).post(`/trips/${doc._id}/pay`).type("form").send({});
    expect(res.headers.location).toBe(`/trips/${doc._id}/pay`);
  });

  test("someone else's booking is a 404 and the service is never called", async () => {
    const doc = waiting({ guest: new mongoose.Types.ObjectId() });
    stubFind(doc);
    const pay = jest.spyOn(payments, "pay");
    const res = await (await loggedIn()).post(`/trips/${doc._id}/pay`).type("form").send({ idempotencyKey: KEY });
    expect(res.status).toBe(404);
    expect(pay).not.toHaveBeenCalled();
  });

  test("a POST without a CSRF token is refused (403) before anything runs", async () => {
    const doc = waiting();
    stubFind(doc);
    const pay = jest.spyOn(payments, "pay");
    const res = await createAgent({ ...withPayments(ON), csrf: false })
      .post(`/trips/${doc._id}/pay`)
      .type("form")
      .send({ idempotencyKey: KEY });
    expect(res.status).toBe(403);
    expect(pay).not.toHaveBeenCalled();
  });
});

describe("checkout hands a new booking to the pay page", () => {
  const TODAY = todayIn();
  const IN = formatDateOnly(addDays(TODAY, 20));
  const OUT = formatDateOnly(addDays(TODAY, 23));

  function stubWorld() {
    const doc = new Listing(
      buildListingData({
        owner: new mongoose.Types.ObjectId(),
        minNights: 1,
        maxNights: 14,
        capacity: { guests: 4 },
        instantBook: false,
        cancellationPolicy: "moderate",
        houseRules: "No parties after 10 pm.",
        checkInTime: "14:00",
        checkOutTime: "11:00",
      }),
    );
    const query = { select: () => query, populate: () => query, then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject) };
    jest.spyOn(Listing, "findById").mockReturnValue(query);
    jest.spyOn(reviewService, "findReviewable").mockResolvedValue(null);
    jest.spyOn(ledger, "unavailableDates").mockResolvedValue([]);
    return doc;
  }
  const form = (doc) => ({
    in: IN,
    out: OUT,
    guests: "2",
    expectedTotalMinor: String(pricing.quote({ listing: doc, checkIn: parseDateOnly(IN), checkOut: parseDateOnly(OUT), guests: 2 }).totalMinor),
    previousLines: "",
    idempotencyKey: "b1b2c3d4e5f60718a1b2c3d4e5f60718",
  });

  test("with the step on: create is asked to wait for payment (15 minutes) and the guest goes to the pay page", async () => {
    const doc = stubWorld();
    const id = new mongoose.Types.ObjectId();
    const create = jest.spyOn(reservations, "create").mockResolvedValue({
      reservation: { _id: id, listing: doc._id, status: "awaiting_payment" },
      created: true,
    });
    const res = await (await loggedIn()).post(`/listings/${doc._id}/checkout`).type("form").send(form(doc));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/trips/${id}/pay`);
    expect(create.mock.calls[0][0]).toMatchObject({ awaitPayment: true, paymentHoldMs: 15 * 60 * 1000 });
  });

  test("the hold length follows PAYMENT_HOLD_MINUTES", async () => {
    const doc = stubWorld();
    const create = jest.spyOn(reservations, "create").mockResolvedValue({
      reservation: { _id: new mongoose.Types.ObjectId(), listing: doc._id, status: "awaiting_payment" },
      created: true,
    });
    await (await loggedIn(withPayments({ ...ON, holdMinutes: 30 }))).post(`/listings/${doc._id}/checkout`).type("form").send(form(doc));
    expect(create.mock.calls[0][0].paymentHoldMs).toBe(30 * 60 * 1000);
  });

  test("with the step off nothing is asked and the old flow runs", async () => {
    const doc = stubWorld();
    const create = jest.spyOn(reservations, "create").mockResolvedValue({
      reservation: { _id: new mongoose.Types.ObjectId(), listing: doc._id, status: "pending" },
      created: true,
    });
    const res = await (await loggedIn(withPayments({ ...ON, simulated: false }))).post(`/listings/${doc._id}/checkout`).type("form").send(form(doc));
    expect(res.headers.location).toBe(`/listings/${doc._id}`);
    expect(create.mock.calls[0][0]).not.toHaveProperty("awaitPayment");
  });
});
