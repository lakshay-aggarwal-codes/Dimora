// P05-T02 against a real MongoDB: dates really remove listings that are taken.
// Skipped with SKIP_DB_TESTS=1.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const StayNight = require("../../src/models/stayNight");
const { addDays, todayIn } = require("../../src/utils/dates");

const reservation = (listing, date, extra = {}) =>
  StayNight.create({
    listing: listing._id,
    date,
    source: { kind: "reservation", id: new mongoose.Types.ObjectId() },
    ...extra,
  });

describeDb("search with dates", () => {
  useTestDb();
  const start = () => addDays(todayIn(), 20);
  const query = (from, to) =>
    `/listings?in=${from.toISOString().slice(0, 10)}&out=${to.toISOString().slice(0, 10)}`;

  async function two() {
    const { user } = await createUser();
    const free = await createListing({ owner: user._id, title: "Free stay" });
    const taken = await createListing({ owner: user._id, title: "Taken stay" });
    return { free, taken };
  }

  test("a listing with a night inside the stay is left out; the other stays", async () => {
    const { taken } = await two();
    await reservation(taken, addDays(start(), 1));
    const res = await createAgent().get(query(start(), addDays(start(), 3)));
    expect(res.text).toContain("Free stay");
    expect(res.text).not.toContain("Taken stay");
  });

  test("the check-out day itself does not block (nights are [in, out))", async () => {
    const { taken } = await two();
    await reservation(taken, addDays(start(), 3));
    const res = await createAgent().get(query(start(), addDays(start(), 3)));
    expect(res.text).toContain("Taken stay");
  });

  test("a host block removes it too; an expired hold does not", async () => {
    const { free, taken } = await two();
    await StayNight.create({
      listing: taken._id,
      date: start(),
      source: { kind: "block", id: new mongoose.Types.ObjectId() },
    });
    await reservation(free, start(), {
      holdExpiresAt: new Date(Date.now() - 60000),
    });
    const res = await createAgent().get(query(start(), addDays(start(), 2)));
    expect(res.text).toContain("Free stay");
    expect(res.text).not.toContain("Taken stay");
  });

  test("without dates nothing is removed", async () => {
    const { taken } = await two();
    await reservation(taken, start());
    expect((await createAgent().get("/listings")).text).toContain("Taken stay");
  });

  test("an invalid date shows the message and still lists everything", async () => {
    await two();
    const res = await createAgent().get(
      "/listings?in=2026-02-30&out=2026-03-05",
    );
    expect(res.text).toContain("Check-in must be a date like 2026-12-24.");
    expect(res.text).toContain("Free stay");
    expect(res.text).toContain("Taken stay");
  });

  test("paging works with a real database: 13 listings make 2 pages", async () => {
    const { user } = await createUser();
    for (let i = 1; i <= 13; i += 1)
      await createListing({
        owner: user._id,
        title: `Stay ${String(i).padStart(2, "0")}`,
      });
    const first = await createAgent().get("/listings");
    const second = await createAgent().get("/listings?page=2");
    expect(first.text).toContain("13 stays");
    expect(
      (first.text.match(/class="card h-100 listing-card"/g) || []).length,
    ).toBe(12);
    expect(
      (second.text.match(/class="card h-100 listing-card"/g) || []).length,
    ).toBe(1);
    expect(second.text).toContain("Stay 01"); // newest first: the oldest is last
  });
});
