// P08-T03 against a real MongoDB: log in through the real form, take the
// quote, open the checkout page, submit its form, and compare the stored
// reservation's total with the quote. Skipped with SKIP_DB_TESTS=1.
//
//   npm test -- tests/integration/checkout.db.test.js
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const { checkDatabase } = require("../helpers/invariants");
const Reservation = require("../../src/models/reservation");
const StayNight = require("../../src/models/stayNight");
const Listing = require("../../src/models/listing");
const { formatMoney } = require("../../src/utils/money");
const { todayIn, addDays, formatDateOnly } = require("../../src/utils/dates");

const D = (n) => formatDateOnly(addDays(todayIn(), n));
const qs = (o) => new URLSearchParams(o).toString();
const field = (html, name) => {
  const hit = new RegExp(
    `<input type="hidden" name="${name}" value="([^"]*)">`,
  ).exec(html);
  return hit ? hit[1] : null;
};

describeDb("checkout (database)", () => {
  useTestDb();

  beforeEach(async () => {
    await Promise.all([Reservation.init(), StayNight.init()]);
  });

  async function world(listingOver = {}) {
    const { user: host } = await createUser();
    const guest = await createUser();
    const listing = await createListing({
      owner: host,
      capacity: { guests: 4 },
      minNights: 1,
      maxNights: 14,
      cancellationPolicy: "flexible",
      ...listingOver,
    });
    const agent = createAgent();
    await login(agent, {
      username: guest.user.username,
      password: guest.password,
    });
    return { host, guest: guest.user, listing, agent };
  }

  const stay = { in: D(30), out: D(33), guests: 2 };
  const formOf = (page) => ({
    in: field(page, "in"),
    out: field(page, "out"),
    guests: field(page, "guests"),
    expectedTotalMinor: field(page, "expectedTotalMinor"),
    previousLines: field(page, "previousLines"),
    idempotencyKey: field(page, "idempotencyKey"),
  });

  test.each([[false], [true]])(
    "quote -> checkout -> reservation: the stored total equals the quoted total (instantBook: %s)",
    async (instantBook) => {
      const { agent, listing, guest } = await world({ instantBook });
      const quote = await agent.get(
        `/api/listings/${listing._id}/quote?${qs(stay)}`,
      );
      expect(quote.body.bookable).toBe(true);
      const total = quote.body.quote.totalMinor;

      const page = (
        await agent.get(`/listings/${listing._id}/checkout?${qs(stay)}`)
      ).text;
      expect(field(page, "expectedTotalMinor")).toBe(String(total));
      expect(page).toContain(formatMoney(total, "INR"));

      const res = await agent
        .post(`/listings/${listing._id}/checkout`)
        .type("form")
        .send(formOf(page));
      expect(res.status).toBe(302);
      const stored = await Reservation.find({ listing: listing._id }).lean();
      expect(stored).toHaveLength(1);
      expect(stored[0].pricingSnapshot.totalMinor).toBe(total);
      expect(stored[0].status).toBe(instantBook ? "confirmed" : "pending");
      expect(String(stored[0].guest)).toBe(String(guest._id));
      expect(
        await StayNight.countDocuments({ "source.id": stored[0]._id }),
      ).toBe(3);
      expect(await checkDatabase()).toEqual([]);
    },
  );

  test("pressing the button twice (same form) makes one reservation", async () => {
    const { agent, listing } = await world();
    const page = (
      await agent.get(`/listings/${listing._id}/checkout?${qs(stay)}`)
    ).text;
    const form = formOf(page);
    const [a, b] = await Promise.all([
      agent.post(`/listings/${listing._id}/checkout`).type("form").send(form),
      agent.post(`/listings/${listing._id}/checkout`).type("form").send(form),
    ]);
    expect([a.status, b.status]).toEqual([302, 302]);
    expect(await Reservation.countDocuments({ listing: listing._id })).toBe(1);
    expect(await StayNight.countDocuments()).toBe(3);
    expect(await checkDatabase()).toEqual([]);
  });

  test("a price change between page and click: 409 with the new total, nothing booked; then it books at the new total", async () => {
    const { agent, listing } = await world();
    const page = (
      await agent.get(`/listings/${listing._id}/checkout?${qs(stay)}`)
    ).text;
    await Listing.updateOne(
      { _id: listing._id },
      { $inc: { "pricing.nightlyMinor": 100000 } },
    );

    const refused = await agent
      .post(`/listings/${listing._id}/checkout`)
      .type("form")
      .send(formOf(page));
    expect(refused.status).toBe(409);
    expect(await Reservation.countDocuments()).toBe(0);
    expect(await StayNight.countDocuments()).toBe(0);
    const newTotal = Number(field(refused.text, "expectedTotalMinor"));
    expect(newTotal).toBeGreaterThan(Number(field(page, "expectedTotalMinor")));

    const ok = await agent
      .post(`/listings/${listing._id}/checkout`)
      .type("form")
      .send({ ...formOf(refused.text), confirmChange: "yes" });
    expect(ok.status).toBe(302);
    const [stored] = await Reservation.find({ listing: listing._id }).lean();
    expect(stored.pricingSnapshot.totalMinor).toBe(newTotal);
    expect(await checkDatabase()).toEqual([]);
  });

  test("nights taken after the page was opened: the second guest is sent back, nothing is double booked", async () => {
    const first = await world();
    const page = (
      await first.agent.get(
        `/listings/${first.listing._id}/checkout?${qs(stay)}`,
      )
    ).text;

    const second = await createUser();
    const other = createAgent();
    await login(other, {
      username: second.user.username,
      password: second.password,
    });
    const otherPage = (
      await other.get(`/listings/${first.listing._id}/checkout?${qs(stay)}`)
    ).text;
    expect(
      (
        await other
          .post(`/listings/${first.listing._id}/checkout`)
          .type("form")
          .send(formOf(otherPage))
      ).status,
    ).toBe(302);

    const res = await first.agent
      .post(`/listings/${first.listing._id}/checkout`)
      .type("form")
      .send(formOf(page));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `/listings/${first.listing._id}?guests=2`,
    );
    expect(
      await Reservation.countDocuments({ listing: first.listing._id }),
    ).toBe(1);
    expect(await StayNight.countDocuments()).toBe(3);
    expect(await checkDatabase()).toEqual([]);

    // and opening the checkout for those nights now sends the guest back too
    const again = await first.agent.get(
      `/listings/${first.listing._id}/checkout?${qs(stay)}`,
    );
    expect(again.status).toBe(302);
  });

  test("a logged-out visitor is sent to log in and returns to the checkout", async () => {
    const { listing } = await world();
    const visitor = createAgent();
    const url = `/listings/${listing._id}/checkout?${qs(stay)}`;
    expect((await visitor.get(url)).headers.location).toBe("/login");
    const { user, password } = await createUser();
    const csrf = /name="csrf-token" content="([^"]*)"/.exec(
      (await visitor.get("/login")).text,
    )[1];
    const res = await visitor
      .post("/login")
      .set("X-CSRF-Token", csrf)
      .type("form")
      .send({ username: user.username, password });
    expect(res.headers.location).toBe(url);
    expect((await visitor.get(url)).status).toBe(200);
  });
});
