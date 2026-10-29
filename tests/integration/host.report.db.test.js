// P13-T04 against a real MongoDB: the host's earnings/occupancy page and CSV.
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing, createCompletedStay } = require("../helpers/factories");
const StayNight = require("../../src/models/stayNight");

// A whole past month (the previous one), so the test works on any run date.
const now = new Date();
const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const key = first.toISOString().slice(0, 7);
const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
const day = (n) => new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), n));
const snapshot = {
  currency: "INR",
  totalMinor: 450000,
  lines: [
    { code: "nights", amountMinor: 300000 },
    { code: "cleaning", amountMinor: 100000 },
    { code: "service_fee", amountMinor: 50000 },
  ],
};

async function signedIn(overrides) {
  const { user, password } = await createUser(overrides);
  return { user, agent: await login(createAgent(), { username: user.username, password }) };
}

async function world() {
  const host = await signedIn();
  const sea = await createListing({ owner: host.user, status: "published", title: "=Sea house" });
  const { user: guest } = await createUser();
  await createCompletedStay({ listing: sea, guest, checkIn: day(5), checkOut: day(8), nights: 3, status: "completed", pricingSnapshot: snapshot });
  // not counted: waiting, cancelled and declined
  for (const [status, d] of [["pending", 10], ["cancelled_by_guest", 12], ["declined", 14]]) {
    await createCompletedStay({ listing: sea, guest, checkIn: day(d), checkOut: day(d + 2), nights: 2, status, pricingSnapshot: snapshot });
  }
  for (const d of [20, 21]) {
    await StayNight.create({ listing: sea._id, date: day(d), source: { kind: "block", id: new mongoose.Types.ObjectId() } });
  }
  // someone else's listing and stay, which must never show
  const other = await createUser();
  const theirs = await createListing({ owner: other.user, status: "published", title: "Not yours" });
  await createCompletedStay({ listing: theirs, guest, checkIn: day(5), checkOut: day(8), nights: 3, pricingSnapshot: snapshot });
  return { host, sea };
}

describeDb("host earnings and occupancy report (database)", () => {
  useTestDb();

  test("a visitor is sent to log in", async () => {
    for (const url of ["/host/report", "/host/report.csv"]) {
      const res = await createAgent().get(url);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/login/);
    }
  });

  test("the page counts the host's own confirmed and completed stays only", async () => {
    const { host } = await world();
    const res = await host.agent.get(`/host/report?from=${key}&to=${key}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.text).toContain("=Sea house");
    expect(res.text).not.toContain("Not yours");
    expect(res.text).toContain("₹4,000"); // 300000 + 100000 paise; the service fee is not the host's
    const percent = Math.round((3 / (daysInMonth - 2)) * 100);
    expect(res.text).toContain(`${percent}%`);
    expect(res.text).toMatch(/Download CSV/);
    expect(res.text).toContain(`href="/host/report.csv?from=${key}&amp;to=${key}"`);
  });

  test("the CSV has the header, one safe line per listing and the right headers", async () => {
    const { host, sea } = await world();
    const res = await host.agent.get(`/host/report.csv?from=${key}&to=${key}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="dimora-report-${key}-to-${key}.csv"`);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    const body = res.text.replace(/^\uFEFF/, "");
    const lines = body.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("listing,listing_id,status,")).toBe(true);
    const percent = Math.round((3 / (daysInMonth - 2)) * 100);
    expect(lines[1]).toBe(
      `'=Sea house,${sea._id},published,${key}-01,${key}-${String(daysInMonth).padStart(2, "0")},1,3,2,${daysInMonth - 2},${percent},4000.00,INR`,
    );
    expect(body).not.toContain("Not yours");
  });

  test("a host without listings gets an empty page and a header-only CSV", async () => {
    const { agent } = await signedIn();
    const page = await agent.get("/host/report");
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/No listings to report on/);
    const csv = await agent.get("/host/report.csv");
    expect(csv.text.replace(/^\uFEFF/, "").trimEnd().split("\r\n")).toHaveLength(1);
  });

  test("bad months give a 400, never a crash or someone else's data", async () => {
    const { host } = await world();
    for (const q of ["from=2026-13", "from=abc&to=2026-02", "from=2026-05&to=2026-01", "from=2000-01&to=2000-02", "from[]=2026-01", "to=2026-10-01"]) {
      expect((await host.agent.get(`/host/report?${q}`)).status).toBe(400);
      expect((await host.agent.get(`/host/report.csv?${q}`)).status).toBe(400);
    }
  });

  test("an admin or any other member sees only their own listings", async () => {
    await world();
    const { agent } = await signedIn();
    const res = await agent.get(`/host/report?from=${key}&to=${key}`);
    expect(res.text).not.toContain("Sea house");
    expect(res.text).not.toContain("Not yours");
  });
});
