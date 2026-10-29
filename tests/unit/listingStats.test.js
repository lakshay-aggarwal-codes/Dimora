// P13-T03: the counting rules of services/listingStats.js against fakes
// (no database).
const { ObjectId } = require("mongoose").Types;
const stats = require("../../src/services/listingStats");

const NOW = new Date("2026-10-29T06:00:00Z"); // 11:30 in India, same UTC day
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

function fakes() {
  const rows = new Map();
  const key = (f) => `${f.listing}|${f.day.toISOString().slice(0, 10)}`;
  const DayStat = {
    rows,
    updateOne: async (f, u) => {
      const k = key(f);
      const row = rows.get(k) || { listing: f.listing, day: f.day, views: 0, saves: 0, checkoutStarts: 0 };
      for (const [field, by] of Object.entries(u.$inc)) row[field] += by;
      rows.set(k, row);
    },
    find: (f) => ({
      lean: async () => [...rows.values()].filter((r) => String(r.listing) === String(f.listing) && r.day >= f.day.$gte && r.day <= f.day.$lte),
    }),
  };
  const life = { saves: 0 };
  const ListingStat = {
    life,
    updateOne: async (f, u) => {
      if (u.$set && f.saves && life.saves < 0) life.saves = u.$set.saves;
    },
    findOne: () => ({ lean: async () => life }),
  };
  let reservations = 0;
  const Reservation = { setCount: (n) => (reservations = n), countDocuments: async () => reservations };
  return { deps: { DayStat, ListingStat, Reservation }, DayStat, ListingStat, Reservation };
}

const listing = (owner = new ObjectId()) => ({ _id: new ObjectId(), owner });
const req = (over = {}) => ({
  get: (h) => (h.toLowerCase() === "user-agent" ? CHROME : undefined),
  session: {},
  user: undefined,
  ...over,
});

describe("isBot", () => {
  test("missing, short and bot-like agents are bots; a browser is not", () => {
    for (const ua of [undefined, null, "", "x", "curl/8.4.0", "Googlebot/2.1 (+http://www.google.com/bot.html)", "facebookexternalhit/1.1", "python-requests/2.31", "HeadlessChrome/120", "Mozilla/5.0 (compatible; bingbot/2.0)", "Slackbot-LinkExpanding 1.0", "UptimeRobot/2.0"]) {
      expect({ ua, bot: stats.isBot(ua) }).toEqual({ ua, bot: true });
    }
    expect(stats.isBot(CHROME)).toBe(false);
    expect(stats.isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")).toBe(false);
  });
});

describe("recordView", () => {
  test("counts once per session per listing per day", async () => {
    const f = fakes();
    const l = listing();
    const r = req();
    expect(await stats.recordView(r, l, { now: NOW, deps: f.deps })).toBe(true);
    expect(await stats.recordView(r, l, { now: NOW, deps: f.deps })).toBe(false);
    expect(await stats.recordView(r, l, { now: new Date("2026-10-29T10:00:00Z"), deps: f.deps })).toBe(false);
    expect([...f.DayStat.rows.values()][0].views).toBe(1);
  });

  test("the next day counts again; another listing and another session count too", async () => {
    const f = fakes();
    const l = listing();
    const r = req();
    await stats.recordView(r, l, { now: NOW, deps: f.deps });
    expect(await stats.recordView(r, l, { now: new Date("2026-10-30T06:00:00Z"), deps: f.deps })).toBe(true);
    expect(await stats.recordView(r, listing(), { now: NOW, deps: f.deps })).toBe(true);
    expect(await stats.recordView(req(), l, { now: NOW, deps: f.deps })).toBe(true);
    expect(f.DayStat.rows.size).toBe(3); // l on day 1 and day 2, the other listing on day 1
    const first = [...f.DayStat.rows.values()].find((r) => String(r.listing) === String(l._id) && r.day.toISOString().startsWith("2026-10-29"));
    expect(first.views).toBe(2); // two sessions
  });

  test("bots, the host, previews and a request without a session are not counted", async () => {
    const f = fakes();
    const l = listing();
    const bot = req({ get: () => "Googlebot/2.1" });
    expect(await stats.recordView(bot, l, { now: NOW, deps: f.deps })).toBe(false);
    expect(bot.session.statSeen).toBeUndefined(); // a bot gets no mark either
    const host = req({ user: { _id: l.owner } });
    expect(await stats.recordView(host, l, { now: NOW, deps: f.deps })).toBe(false);
    expect(await stats.recordView(req(), l, { now: NOW, preview: true, deps: f.deps })).toBe(false);
    expect(await stats.recordView(req({ session: undefined }), l, { now: NOW, deps: f.deps })).toBe(false);
    expect(await stats.recordView(null, l, { now: NOW, deps: f.deps })).toBe(false);
    expect(f.DayStat.rows.size).toBe(0);
  });

  test("a populated owner (document) is recognised as the host", async () => {
    const f = fakes();
    const ownerId = new ObjectId();
    const l = { _id: new ObjectId(), owner: { _id: ownerId, username: "h" } };
    expect(await stats.recordView(req({ user: { _id: ownerId } }), l, { now: NOW, deps: f.deps })).toBe(false);
    expect(await stats.recordView(req({ user: { _id: new ObjectId() } }), l, { now: NOW, deps: f.deps })).toBe(true);
  });

  test("a database failure is swallowed and logged, never thrown", async () => {
    const f = fakes();
    f.DayStat.updateOne = async () => {
      throw new Error("db down");
    };
    const warn = jest.fn();
    const r = req({ log: { warn } });
    await expect(stats.recordView(r, listing(), { now: NOW, deps: f.deps })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a duplicate-key race on the first insert is retried once", async () => {
    const f = fakes();
    const real = f.DayStat.updateOne;
    let calls = 0;
    f.DayStat.updateOne = async (...args) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("E11000"), { code: 11000 });
      return real(...args);
    };
    expect(await stats.recordView(req(), listing(), { now: NOW, deps: f.deps })).toBe(true);
    expect(calls).toBe(2);
    expect([...f.DayStat.rows.values()][0].views).toBe(1);
  });
});

describe("session marks", () => {
  test("old days are dropped and the list stays bounded", () => {
    const session = { statSeen: { "v:old": "2026-10-01" } };
    for (let i = 0; i < stats.MAX_SEEN + 20; i += 1) stats.firstTimeToday(session, `v:${i}`, NOW);
    expect(session.statSeen["v:old"]).toBeUndefined();
    expect(Object.keys(session.statSeen).length).toBeLessThanOrEqual(stats.MAX_SEEN);
  });

  test("a junk value in the session does not break it", () => {
    for (const junk of [null, "x", 5, []]) {
      const session = { statSeen: junk };
      expect(stats.firstTimeToday(session, "v:1", NOW)).toBe(true);
    }
  });
});

describe("checkout starts and saves", () => {
  test("a checkout start counts once a day per listing and is separate from views", async () => {
    const f = fakes();
    const l = listing();
    const r = req();
    expect(await stats.recordCheckoutStart(r, l, { now: NOW, deps: f.deps })).toBe(true);
    expect(await stats.recordCheckoutStart(r, l, { now: NOW, deps: f.deps })).toBe(false);
    expect(await stats.recordView(r, l, { now: NOW, deps: f.deps })).toBe(true);
    const row = [...f.DayStat.rows.values()][0];
    expect([row.views, row.checkoutStarts]).toEqual([1, 1]);
  });

  test("recordSave adds to today's saves and never throws", async () => {
    const f = fakes();
    const id = new ObjectId();
    await stats.recordSave(id, { now: NOW, deps: f.deps });
    await stats.recordSave(id, { now: NOW, deps: f.deps });
    expect([...f.DayStat.rows.values()][0].saves).toBe(2);
    f.DayStat.updateOne = async () => {
      throw new Error("db down");
    };
    await expect(stats.recordSave(id, { now: NOW, deps: f.deps })).resolves.toBeUndefined();
  });

  test("clampSaves lifts a negative lifetime total to zero and leaves a positive one alone", async () => {
    const f = fakes();
    f.ListingStat.life.saves = -2;
    await stats.clampSaves(new ObjectId(), { deps: f.deps });
    expect(f.ListingStat.life.saves).toBe(0);
    f.ListingStat.life.saves = 3;
    await stats.clampSaves(new ObjectId(), { deps: f.deps });
    expect(f.ListingStat.life.saves).toBe(3);
  });
});

describe("getStats", () => {
  test("30 days oldest first with zeros filled in, today last", async () => {
    const f = fakes();
    const l = listing();
    await stats.recordView(req(), l, { now: NOW, deps: f.deps });
    await stats.recordView(req(), l, { now: new Date("2026-10-27T06:00:00Z"), deps: f.deps });
    const out = await stats.getStats(l._id, { now: NOW, deps: f.deps });
    expect(out.series).toHaveLength(30);
    expect(out.series[29].day).toBe("2026-10-29");
    expect(out.series[0].day).toBe("2026-09-30");
    expect(out.series.map((p) => p.views).reduce((a, b) => a + b, 0)).toBe(2);
    expect(out.series.find((p) => p.day === "2026-10-28").views).toBe(0);
    expect(out.total).toEqual({ views: 2, saves: 0, checkoutStarts: 0 });
  });

  test("days outside the window are not counted", async () => {
    const f = fakes();
    const l = listing();
    await stats.recordView(req(), l, { now: new Date("2026-08-01T06:00:00Z"), deps: f.deps });
    const out = await stats.getStats(l._id, { now: NOW, deps: f.deps });
    expect(out.total.views).toBe(0);
  });

  test("conversion only from 30 views, as bookings over views, to one decimal, never above 100", async () => {
    const f = fakes();
    const l = listing();
    const day = (n) => new Date(`2026-10-${String(n).padStart(2, "0")}T06:00:00Z`);
    for (let i = 0; i < 29; i += 1) await stats.recordView(req(), l, { now: day(10 + (i % 15)), deps: f.deps });
    f.Reservation.setCount(5);
    expect((await stats.getStats(l._id, { now: NOW, deps: f.deps })).conversion).toBeNull();
    await stats.recordView(req(), l, { now: NOW, deps: f.deps });
    const out = await stats.getStats(l._id, { now: NOW, deps: f.deps });
    expect(out.total.views).toBe(30);
    expect(out.conversion).toBe(16.7);
    f.Reservation.setCount(500);
    expect((await stats.getStats(l._id, { now: NOW, deps: f.deps })).conversion).toBe(100);
  });

  test("savedNow is the lifetime total and never negative", async () => {
    const f = fakes();
    f.ListingStat.life.saves = -4;
    expect((await stats.getStats(new ObjectId(), { now: NOW, deps: f.deps })).savedNow).toBe(0);
    f.ListingStat.life.saves = 7;
    expect((await stats.getStats(new ObjectId(), { now: NOW, deps: f.deps })).savedNow).toBe(7);
  });
});
