// P07-T03 through the real routes and a real MongoDB: the host availability
// calendar, blocking and unblocking, and what that does to bookings.
// Needs a MongoDB (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const StayNight = require("../../src/models/stayNight");
const AvailabilityBlock = require("../../src/models/availabilityBlock");
const ledger = require("../../src/services/ledger");
const availability = require("../../src/services/availability");
const {
  todayIn,
  addDays,
  addMonths,
  startOfMonth,
  formatDateOnly,
} = require("../../src/utils/dates");
const mongoose = require("mongoose");

// The page works in the listing's time zone (Asia/Kolkata by default).
const TODAY = todayIn("Asia/Kolkata");
const day = (n) => formatDateOnly(addDays(TODAY, n));
const date = (n) => addDays(TODAY, n);
const nightsOf = (from, count) =>
  Array.from({ length: count }, (_, i) => date(from + i));
const newId = () => new mongoose.Types.ObjectId();

async function signedIn() {
  const { user, password } = await createUser();
  const agent = await login(createAgent(), { username: user.username, password });
  return { agent, user };
}

async function hostWithListing(overrides = {}) {
  const ctx = await signedIn();
  const listing = await createListing({ owner: ctx.user._id, ...overrides });
  return { ...ctx, listing };
}

const calendarUrl = (listing, query = "") => `/host/listings/${listing._id}/calendar${query}`;
const blockUrl = (listing) => `${calendarUrl(listing)}/blocks`;
const unblockUrl = (listing) => `${calendarUrl(listing)}/unblock`;
const rows = (listing, kind) =>
  StayNight.find({ listing: listing._id, ...(kind ? { "source.kind": kind } : {}) }).lean();

describeDb("Host availability calendar", () => {
  useTestDb();

  describe("who may open it", () => {
    test("anonymous visitors are sent to /login", async () => {
      const { listing } = await hostWithListing();
      const res = await createAgent().get(calendarUrl(listing));
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login");
    });

    test("another member gets 403 on every route and changes nothing", async () => {
      const { listing } = await hostWithListing();
      const { agent: stranger } = await signedIn();
      expect((await stranger.get(calendarUrl(listing))).status).toBe(403);
      const res = await stranger
        .post(blockUrl(listing))
        .type("form")
        .send({ from: day(3), through: day(4) });
      expect(res.status).toBe(403);
      expect((await stranger.post(unblockUrl(listing)).type("form").send({ from: day(3), through: day(4) })).status).toBe(403);
      expect(await rows(listing)).toHaveLength(0);
      expect(await AvailabilityBlock.countDocuments()).toBe(0);
    });

    test("the host sees the calendar of a published listing", async () => {
      const { agent, listing } = await hostWithListing({ title: "Beach house" });
      const res = await agent.get(calendarUrl(listing));
      expect(res.status).toBe(200);
      expect(res.text).toContain("Availability: Beach house");
      expect(res.text).toContain("Block nights");
    });

    test("an unpublished listing can be managed too", async () => {
      const { agent, listing } = await hostWithListing({ status: "unpublished" });
      expect((await agent.get(calendarUrl(listing))).status).toBe(200);
    });

    test("a draft is sent back to the wizard, a suspended listing to its status page", async () => {
      const { agent, listing: draft } = await hostWithListing({ status: "draft" });
      const res = await agent.get(calendarUrl(draft));
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/host/listings/${draft._id}`);

      const { agent: other, listing: suspended } = await hostWithListing({ status: "suspended" });
      const res2 = await other.get(calendarUrl(suspended));
      expect(res2.status).toBe(302);
      expect(res2.headers.location).toBe(`/host/listings/${suspended._id}/status`);
    });

    test("a deleted listing and an unknown id are 404", async () => {
      const { agent, listing } = await hostWithListing({ deletedAt: new Date() });
      expect((await agent.get(calendarUrl(listing))).status).toBe(404);
      expect((await agent.get(`/host/listings/${newId()}/calendar`)).status).toBe(404);
      expect((await agent.get("/host/listings/not-an-id/calendar")).status).toBe(404);
    });
  });

  describe("the month grid", () => {
    test("shows blocked and reserved nights of this listing only", async () => {
      const { agent, listing } = await hostWithListing();
      const other = await createListing({ owner: listing.owner });
      // Next month, so all nights are in the one month that is opened.
      const first = startOfMonth(addMonths(TODAY, 1));
      const at = (n) => addDays(first, n);
      const key = formatDateOnly(first).slice(0, 7);
      await ledger.reserveNights(listing._id, [at(2), at(3)], { kind: "block", id: newId() });
      await ledger.reserveNights(listing._id, [at(6)], { kind: "reservation", id: newId() });
      await ledger.reserveNights(other._id, [at(10), at(11), at(12)], { kind: "block", id: newId() });
      const res = await agent.get(calendarUrl(listing, `?month=${key}`));
      expect(res.status).toBe(200);
      expect((res.text.match(/blocked by you/g) || []).length).toBe(2);
      expect((res.text.match(/reserved by a guest/g) || []).length).toBe(1);
      expect(res.text).toContain("2 blocked, 1 reserved, 0 awaiting your answer");
    });

    test("?month= opens that month; a bad value shows this month", async () => {
      const { agent, listing } = await hostWithListing();
      const next = formatDateOnly(addDays(TODAY, 40)).slice(0, 7);
      const ok = await agent.get(calendarUrl(listing, `?month=${next}`));
      expect(ok.status).toBe(200);
      const bad = await agent.get(calendarUrl(listing, "?month=banana"));
      expect(bad.status).toBe(200);
      const arr = await agent.get(calendarUrl(listing, "?month[]=2026-11"));
      expect(arr.status).toBe(200);
    });

    test("the page carries no guest identity or ledger id", async () => {
      const { agent, listing } = await hostWithListing();
      const guest = await createUser();
      const source = { kind: "reservation", id: guest.user._id };
      await ledger.reserveNights(listing._id, nightsOf(2, 2), source);
      const res = await agent.get(calendarUrl(listing));
      expect(res.text).not.toContain(String(guest.user._id));
      expect(res.text).not.toContain(guest.user.username);
      expect(res.text).not.toContain(guest.user.email);
    });
  });

  describe("blocking", () => {
    test("creates one ledger row per night (kind block) and a note record", async () => {
      const { agent, listing, user } = await hostWithListing();
      const res = await agent
        .post(blockUrl(listing))
        .type("form")
        .send({ from: day(3), through: day(5), note: "Family visit" });
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(`/host/listings/${listing._id}/calendar?month=`);

      const found = await rows(listing);
      expect(found).toHaveLength(3);
      expect(found.every((r) => r.source.kind === "block")).toBe(true);
      expect(new Set(found.map((r) => String(r.source.id))).size).toBe(1);
      expect(found.every((r) => !r.holdExpiresAt)).toBe(true);

      const records = await AvailabilityBlock.find().lean();
      expect(records).toHaveLength(1);
      expect(String(records[0]._id)).toBe(String(found[0].source.id));
      expect(records[0].note).toBe("Family visit");
      expect(String(records[0].createdBy)).toBe(String(user._id));
      expect(String(records[0].listing)).toBe(String(listing._id));
    });

    test("the follow-up page confirms it and lists the block with its note (escaped)", async () => {
      const { agent, listing } = await hostWithListing();
      const res = await agent
        .post(blockUrl(listing))
        .type("form")
        .send({ from: day(3), through: day(4), note: "<b>trip</b>" });
      const page = await agent.get(res.headers.location);
      expect(page.text).toContain("Blocked 2 nights.");
      expect(page.text).toContain("&lt;b&gt;trip&lt;/b&gt;");
      expect(page.text).not.toContain("<b>trip</b>");
      expect(page.text).toContain("Your upcoming blocks");
    });

    test("bad input: 400, the form comes back filled in, nothing is stored", async () => {
      const { agent, listing } = await hostWithListing();
      const res = await agent
        .post(blockUrl(listing))
        .type("form")
        .send({ from: day(5), through: day(3), note: "keep me" });
      expect(res.status).toBe(400);
      expect(res.text).toContain("cannot be before the first night");
      expect(res.text).toContain('value="keep me"');
      expect(await rows(listing)).toHaveLength(0);

      for (const body of [
        { from: "2026-02-30", through: day(3) },
        { from: day(3) },
        { from: day(-2), through: day(2) },
        { from: day(3), through: day(400) },
        { from: day(3), through: day(4), note: "x".repeat(201) },
        { from: ["a", "b"], through: day(4) },
      ]) {
        const bad = await agent.post(blockUrl(listing)).type("form").send(body);
        expect(bad.status).toBe(400);
      }
      expect(await rows(listing)).toHaveLength(0);
      expect(await AvailabilityBlock.countDocuments()).toBe(0);
    });

    test("nights a guest has reserved cannot be blocked: 409 and nothing is blocked", async () => {
      const { agent, listing } = await hostWithListing();
      const stay = { kind: "reservation", id: newId() };
      await ledger.reserveNights(listing._id, nightsOf(4, 2), stay);
      const res = await agent
        .post(blockUrl(listing))
        .type("form")
        .send({ from: day(2), through: day(8) });
      expect(res.status).toBe(409);
      expect(res.text).toContain("Guests already hold these nights");
      const after = await rows(listing);
      expect(after).toHaveLength(2);
      expect(after.every((r) => String(r.source.id) === String(stay.id))).toBe(true);
      expect(await AvailabilityBlock.countDocuments()).toBe(0);
    });

    test("a pending request's live hold also stops a block, an expired hold does not", async () => {
      const { agent, listing } = await hostWithListing();
      const soon = new Date(Date.now() + 60 * 60 * 1000);
      await ledger.reserveNights(listing._id, nightsOf(4, 1), { kind: "reservation", id: newId() }, soon);
      const blocked = await agent.post(blockUrl(listing)).type("form").send({ from: day(4), through: day(4) });
      expect(blocked.status).toBe(409);

      // An expired hold: written directly (reserveNights refuses a hold in the past).
      await StayNight.create({
        listing: listing._id,
        date: date(10),
        source: { kind: "reservation", id: newId() },
        holdExpiresAt: new Date(Date.now() - 60 * 1000),
      });
      const free = await agent.post(blockUrl(listing)).type("form").send({ from: day(10), through: day(10) });
      expect(free.status).toBe(302);
      const kinds = (await rows(listing)).filter((r) => r.date.getTime() === date(10).getTime());
      expect(kinds).toHaveLength(1);
      expect(kinds[0].source.kind).toBe("block");
    });

    test("blocking nights that are already blocked is harmless and says so", async () => {
      const { agent, listing } = await hostWithListing();
      await agent.post(blockUrl(listing)).type("form").send({ from: day(3), through: day(4) });
      const again = await agent.post(blockUrl(listing)).type("form").send({ from: day(3), through: day(4) });
      expect(again.status).toBe(302);
      expect(await rows(listing)).toHaveLength(2);
      expect(await AvailabilityBlock.countDocuments()).toBe(1);
      const page = await agent.get(again.headers.location);
      expect(page.text).toContain("Those nights were already blocked.");
    });
  });

  describe("what a block does to bookings", () => {
    test("a blocked night rejects a booking (409 nights_unavailable), a free neighbour does not", async () => {
      const { agent, listing } = await hostWithListing();
      await agent.post(blockUrl(listing)).type("form").send({ from: day(5), through: day(6) });
      await expect(
        ledger.reserveNights(listing._id, nightsOf(6, 3), { kind: "reservation", id: newId() }),
      ).rejects.toMatchObject({ statusCode: 409, code: "nights_unavailable" });
      expect((await rows(listing, "reservation"))).toHaveLength(0);
      await ledger.reserveNights(listing._id, nightsOf(7, 2), { kind: "reservation", id: newId() });
      expect((await rows(listing, "reservation"))).toHaveLength(2);
    });

    test("date search leaves out a listing whose dates are blocked, and includes it again after unblocking", async () => {
      const { agent, listing } = await hostWithListing();
      await agent.post(blockUrl(listing)).type("form").send({ from: day(5), through: day(6) });
      const taken = await ledger.unavailableListingIds(date(5), date(7));
      expect(taken.map(String)).toContain(String(listing._id));
      await agent.post(unblockUrl(listing)).type("form").send({ from: day(5), through: day(6) });
      const free = await ledger.unavailableListingIds(date(5), date(7));
      expect(free.map(String)).not.toContain(String(listing._id));
    });

    test("a block and a booking for the same nights, started together: exactly one wins", async () => {
      const { listing } = await hostWithListing();
      for (let round = 0; round < 5; round += 1) {
        const from = 20 + round * 5;
        const outcomes = await Promise.allSettled([
          availability.blockDates(
            listing,
            { from: day(from), through: day(from + 1) },
            {},
          ),
          ledger.reserveNights(listing._id, nightsOf(from, 2), { kind: "reservation", id: newId() }),
        ]);
        expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
        const found = (await rows(listing)).filter(
          (r) => r.date >= date(from) && r.date < date(from + 2),
        );
        expect(found).toHaveLength(2);
        expect(new Set(found.map((r) => String(r.source.id))).size).toBe(1);
      }
    });

    test("10 hosts' blocks and bookings racing over the same nights never share a night", async () => {
      const { listing } = await hostWithListing();
      const attempts = [];
      for (let i = 0; i < 10; i += 1) {
        attempts.push(
          availability.blockDates(listing, { from: day(60), through: day(62) }, {}),
          ledger.reserveNights(listing._id, nightsOf(60, 3), { kind: "reservation", id: newId() }),
        );
      }
      await Promise.allSettled(attempts);
      const found = await rows(listing);
      expect(found).toHaveLength(3);
      expect(new Set(found.map((r) => String(r.source.id))).size).toBe(1);
    });
  });

  describe("unblocking", () => {
    test("frees a whole block and removes its note record", async () => {
      const { agent, listing } = await hostWithListing();
      await agent.post(blockUrl(listing)).type("form").send({ from: day(3), through: day(5), note: "x" });
      const res = await agent.post(unblockUrl(listing)).type("form").send({ from: day(3), through: day(5) });
      expect(res.status).toBe(302);
      expect(await rows(listing)).toHaveLength(0);
      expect(await AvailabilityBlock.countDocuments()).toBe(0);
      const page = await agent.get(res.headers.location);
      expect(page.text).toContain("Unblocked 3 nights.");
    });

    test("removes only block rows: a reservation inside the range stays", async () => {
      const { agent, listing } = await hostWithListing();
      await agent.post(blockUrl(listing)).type("form").send({ from: day(3), through: day(4) });
      const stay = { kind: "reservation", id: newId() };
      await ledger.reserveNights(listing._id, nightsOf(5, 3), stay);
      await agent.post(unblockUrl(listing)).type("form").send({ from: day(1), through: day(30) });
      const left = await rows(listing);
      expect(left).toHaveLength(3);
      expect(left.every((r) => r.source.kind === "reservation")).toBe(true);
    });

    test("unblocking only reserved nights changes nothing and says so", async () => {
      const { agent, listing } = await hostWithListing();
      await ledger.reserveNights(listing._id, nightsOf(5, 2), { kind: "reservation", id: newId() });
      const res = await agent.post(unblockUrl(listing)).type("form").send({ from: day(5), through: day(6) });
      expect(res.status).toBe(302);
      expect(await rows(listing)).toHaveLength(2);
      const page = await agent.get(res.headers.location);
      expect(page.text).toContain("Nothing was blocked between those dates.");
    });

    test("part of a block can be freed; the rest and its note stay", async () => {
      const { agent, listing } = await hostWithListing();
      await agent.post(blockUrl(listing)).type("form").send({ from: day(3), through: day(7), note: "trip" });
      await agent.post(unblockUrl(listing)).type("form").send({ from: day(5), through: day(5) });
      const left = await rows(listing);
      expect(left).toHaveLength(4);
      expect(await AvailabilityBlock.countDocuments()).toBe(1);
      const page = await agent.get(calendarUrl(listing));
      expect(page.text).toContain("trip");
    });

    test("only the host's own listing is affected", async () => {
      const mine = await hostWithListing();
      const theirs = await createListing({ owner: (await createUser()).user._id });
      await ledger.reserveNights(theirs._id, nightsOf(3, 2), { kind: "block", id: newId() });
      await mine.agent.post(unblockUrl(mine.listing)).type("form").send({ from: day(1), through: day(30) });
      expect(await rows(theirs)).toHaveLength(2);
    });

    test("bad dates: 400 and the unblock section opens", async () => {
      const { agent, listing } = await hostWithListing();
      const res = await agent.post(unblockUrl(listing)).type("form").send({ from: day(-3), through: day(2) });
      expect(res.status).toBe(400);
      expect(res.text).toContain("already passed");
      expect(res.text).toMatch(/<details class="cal-unblock" open>/);
    });
  });

  describe("links", () => {
    test("My listings and the status page link to the calendar of a live listing", async () => {
      const { agent, listing } = await hostWithListing();
      const mine = await agent.get("/host/listings");
      expect(mine.text).toContain(`href="/host/listings/${listing._id}/calendar"`);
      const status = await agent.get(`/host/listings/${listing._id}/status`);
      expect(status.text).toContain(`href="/host/listings/${listing._id}/calendar"`);
    });

    test("a draft has no calendar link", async () => {
      const { agent, listing } = await hostWithListing({ status: "draft" });
      const mine = await agent.get("/host/listings");
      expect(mine.text).not.toContain(`/host/listings/${listing._id}/calendar`);
      const status = await agent.get(`/host/listings/${listing._id}/status`);
      expect(status.text).not.toContain("/calendar");
    });
  });
});
