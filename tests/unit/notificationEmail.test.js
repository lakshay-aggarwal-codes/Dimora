// P11-T05: which notifications are emailed, to whom, and the "stop these
// emails" links. In-memory fakes; no database, no network.
const prefs = require("../../src/services/notificationEmail");
const { GROUPS, GROUP_OF_TYPE, TOGGLEABLE } = require("../../src/config/notificationPrefs");
const { EVENT_NAMES } = require("../../src/services/notificationEvents");

const SECRET = "s".repeat(40);
const ID = "64b0f0f0f0f0f0f0f0f0abcd";

describe("groups", () => {
  test("every notification type of the event table belongs to exactly one group", () => {
    for (const name of EVENT_NAMES) expect(GROUP_OF_TYPE.has(name)).toBe(true);
    const all = GROUPS.flatMap((g) => g.types);
    expect(new Set(all).size).toBe(all.length);
  });

  test("only the groups that are not essential can be switched off", () => {
    expect(TOGGLEABLE).toEqual(["bookings", "reminders", "reviews"]);
    expect(GROUPS.find((g) => g.key === "moderation").essential).toBe(true);
  });
});

describe("wantsEmail / effectivePrefs", () => {
  test("defaults until the member chooses, then their choice; essential is always on", () => {
    expect(prefs.wantsEmail({}, "reservation.requested")).toBe(true);
    expect(prefs.wantsEmail({ notificationEmail: {} }, "reservation.requested")).toBe(true);
    expect(prefs.wantsEmail({ notificationEmail: { bookings: false } }, "reservation.requested")).toBe(false);
    expect(prefs.wantsEmail({ notificationEmail: { bookings: false } }, "review.available")).toBe(true);
    expect(prefs.wantsEmail({ notificationEmail: { reminders: false } }, "reservation.checkin_tomorrow")).toBe(false);
    expect(prefs.wantsEmail({ notificationEmail: { moderation: false } }, "listing.suspended")).toBe(true);
    expect(prefs.wantsEmail({}, "something.else")).toBe(false);
  });

  test("the settings page data", () => {
    const rows = prefs.effectivePrefs({ notificationEmail: { reviews: false } });
    expect(rows.map((r) => [r.key, r.enabled, r.essential])).toEqual([
      ["bookings", true, false],
      ["reminders", true, false],
      ["reviews", false, false],
      ["moderation", true, true],
    ]);
  });
});

describe("unsubscribe tokens", () => {
  test("a token we made reads back to the member and the group", () => {
    const token = prefs.unsubscribeToken({ userId: ID, group: "bookings", secret: SECRET });
    expect(token).toMatch(prefs.TOKEN_PATTERN);
    expect(prefs.readUnsubscribeToken(token, SECRET)).toEqual({ userId: ID, group: "bookings" });
  });

  test("another secret, another member, another group, a cut or odd token are all refused", () => {
    const token = prefs.unsubscribeToken({ userId: ID, group: "bookings", secret: SECRET });
    const [u, g, m] = token.split(".");
    expect(prefs.readUnsubscribeToken(token, "x".repeat(40))).toBeNull();
    expect(prefs.readUnsubscribeToken(`${"1".repeat(24)}.${g}.${m}`, SECRET)).toBeNull();
    expect(prefs.readUnsubscribeToken(`${u}.reviews.${m}`, SECRET)).toBeNull();
    for (const bad of [token.slice(0, -1), "", "nope", undefined, null, ["a"], `${token}x`, `${u}.${g}.${"A".repeat(43)}`]) {
      expect(prefs.readUnsubscribeToken(bad, SECRET)).toBeNull();
    }
  });

  test("an essential group has no unsubscribe token", () => {
    const token = prefs.unsubscribeToken({ userId: ID, group: "moderation", secret: SECRET });
    expect(prefs.readUnsubscribeToken(token, SECRET)).toBeNull();
  });
});

function world(user) {
  const sent = [];
  const warned = [];
  const users = {
    findById: () => ({ select: () => ({ lean: async () => user }) }),
  };
  const emailService = { send: async (m) => sent.push(m) };
  const mailer = prefs.createNotificationMailer({
    UserModel: users,
    emailService,
    baseUrl: "https://dimora.example.com/",
    secret: SECRET,
    logger: { warn: (...a) => warned.push(a) },
  });
  return { mailer, sent, warned, emailService };
}
const member = (extra = {}) => ({
  _id: ID, email: "ravi@example.com", username: "ravi", displayName: "Ravi", status: "active",
  emailVerifiedAt: new Date("2026-01-01"), ...extra,
});
const note = (type = "reservation.accepted", url = "/trips/abc") => ({
  userId: ID, type, payload: { title: "Your request was accepted: Sea house", body: "12 Nov to 15 Nov", url },
});

describe("mailer.deliver", () => {
  test("a confirmed member who wants it: one email with an absolute link and a stop link", async () => {
    const w = world(member());
    await expect(w.mailer.deliver(note())).resolves.toEqual({ sent: true });
    expect(w.sent).toHaveLength(1);
    const m = w.sent[0];
    expect(m.to).toBe("ravi@example.com");
    expect(m.subject).toBe("Your request was accepted: Sea house");
    expect(m.text).toContain("https://dimora.example.com/trips/abc");
    const stop = /https:\/\/dimora\.example\.com\/email\/unsubscribe\/([^\s>]+)/.exec(m.text)[1];
    expect(prefs.readUnsubscribeToken(stop.replace(/[.)]$/, ""), SECRET)).toEqual({ userId: ID, group: "bookings" });
    expect(m.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/dimora\.example\.com\/email\/unsubscribe\/.+>$/);
    expect(m.html).toContain("Stop these emails");
  });

  test("switched off, unconfirmed, suspended, missing or unknown type: nothing is sent", async () => {
    const cases = [
      [member({ notificationEmail: { bookings: false } }), note(), "switched_off"],
      [member({ emailVerifiedAt: null }), note(), "unconfirmed"],
      [member({ status: "suspended" }), note(), "no_account"],
      [member({ status: "deleted" }), note(), "no_account"],
      [null, note(), "no_account"],
      [member(), note("chat.message"), "no_group"],
    ];
    for (const [user, n, reason] of cases) {
      const w = world(user);
      await expect(w.mailer.deliver(n)).resolves.toEqual({ sent: false, reason });
      expect(w.sent).toEqual([]);
    }
  });

  test("an essential message is sent even if everything optional is off, with no stop link", async () => {
    const w = world(member({ notificationEmail: { bookings: false, reminders: false, reviews: false } }));
    await expect(w.mailer.deliver(note("listing.suspended", "/host/listings/1/status"))).resolves.toEqual({ sent: true });
    const m = w.sent[0];
    expect(m.headers).toBeUndefined();
    expect(m.text).not.toContain("/email/unsubscribe/");
    expect(m.text).toContain("cannot be turned off");
  });

  test("a link that is not a path on this site becomes the home page address", async () => {
    const w = world(member());
    await w.mailer.deliver(note("reservation.accepted", "//evil.example/x"));
    expect(w.sent[0].text).toContain("https://dimora.example.com\n");
    expect(w.sent[0].text).not.toContain("evil.example");
  });

  test("a failing provider is logged without the address and never thrown", async () => {
    const w = world(member());
    w.emailService.send = async () => { throw new Error("the email provider answered 500"); };
    await expect(w.mailer.deliver(note())).resolves.toEqual({ sent: false, reason: "failed" });
    expect(w.warned).toHaveLength(1);
    expect(JSON.stringify(w.warned)).not.toContain("ravi@example.com");
  });

  test("the HTML is escaped (a hostile listing title)", async () => {
    const w = world(member());
    await w.mailer.deliver({ ...note(), payload: { title: "<script>alert(1)</script>", body: "<img src=x onerror=1>", url: "/trips/1" } });
    expect(w.sent[0].html).not.toContain("<script>");
    expect(w.sent[0].html).not.toContain("<img");
    expect(w.sent[0].html).toContain("&lt;script&gt;");
  });
});

describe("savePrefs / unsubscribe", () => {
  const fakeUsers = () => {
    const calls = [];
    return {
      calls,
      updateOne: async (filter, update) => { calls.push([filter, update]); return { matchedCount: filter._id === ID ? 1 : 0 }; },
    };
  };

  test("each switchable group is saved; a missing box is off; essential and unknown fields are ignored", async () => {
    const Users = fakeUsers();
    await prefs.savePrefs(ID, { bookings: "on", moderation: "off", evil: "on", $where: "1" }, { UserModel: Users });
    expect(Users.calls[0][0]).toEqual({ _id: ID });
    expect(Users.calls[0][1]).toEqual({
      $set: { "notificationEmail.bookings": true, "notificationEmail.reminders": false, "notificationEmail.reviews": false },
    });
  });

  test("unsubscribe switches off exactly the group in the token, for an active account", async () => {
    const Users = fakeUsers();
    const token = prefs.unsubscribeToken({ userId: ID, group: "reviews", secret: SECRET });
    const result = await prefs.unsubscribe(token, SECRET, { UserModel: Users });
    expect(result.ok).toBe(true);
    expect(result.group.key).toBe("reviews");
    expect(Users.calls[0]).toEqual([{ _id: ID, status: "active" }, { $set: { "notificationEmail.reviews": false } }]);
  });

  test("a bad token touches nothing; a token of a vanished account is not ok", async () => {
    const Users = fakeUsers();
    expect(await prefs.unsubscribe("junk", SECRET, { UserModel: Users })).toEqual({ ok: false });
    expect(Users.calls).toEqual([]);
    const other = prefs.unsubscribeToken({ userId: "1".repeat(24), group: "reviews", secret: SECRET });
    expect(await prefs.unsubscribe(other, SECRET, { UserModel: Users })).toEqual({ ok: false });
  });
});
