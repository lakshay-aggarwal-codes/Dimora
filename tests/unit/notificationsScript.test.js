// public/js/notifications.js: the pure display logic, in a Node vm, and the
// polling loop against a fake document and fetch. Seeing the bell change in a
// real browser is a manual check (docs/tasks/P11-T01.md).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "notifications.js"),
  "utf8",
);

function load(extra = {}) {
  const context = { ...extra };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context;
}
const core = load().DimoraNotificationsCore;

describe("badgeText", () => {
  test("shows the number, and 99+ above 99", () => {
    expect(core.badgeText(1)).toBe("1");
    expect(core.badgeText(99)).toBe("99");
    expect(core.badgeText(100)).toBe("99+");
    expect(core.badgeText(5000)).toBe("99+");
  });
});

describe("countLabel", () => {
  test("is the bell's accessible name", () => {
    expect(core.countLabel(0)).toBe("Notifications");
    expect(core.countLabel(1)).toBe("Notifications, 1 unread");
    expect(core.countLabel(120)).toBe("Notifications, 120 unread");
  });
});

describe("parseCount", () => {
  test("accepts a whole number of zero or more", () => {
    expect(core.parseCount({ unread: 0 })).toBe(0);
    expect(core.parseCount({ unread: 7 })).toBe(7);
  });
  test.each([
    null,
    undefined,
    "3",
    {},
    { unread: "3" },
    { unread: -1 },
    { unread: 1.5 },
    { unread: null },
    { error: { status: 401 } },
  ])("rejects %j", (body) => {
    expect(core.parseCount(body)).toBeNull();
  });
});

describe("pollSeconds", () => {
  test("keeps the page's value between 10 and 300, else 30", () => {
    expect(core.pollSeconds("30")).toBe(30);
    expect(core.pollSeconds("1")).toBe(10);
    expect(core.pollSeconds("99999")).toBe(300);
    expect(core.pollSeconds("abc")).toBe(30);
    expect(core.pollSeconds(null)).toBe(30);
    expect(core.pollSeconds("")).toBe(30);
  });
});

// A fake page with one bell, a fake fetch and a fake clock.
function page({ responses }) {
  const listeners = {};
  const timers = [];
  const attrs = {
    "data-count-url": "/api/notifications/count",
    "data-poll-seconds": "30",
  };
  const badge = { textContent: "0", hidden: true };
  const label = { textContent: "Notifications" };
  const bell = {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: (selector) =>
      selector === "[data-bell-count]"
        ? badge
        : selector === "[data-bell-label]"
          ? label
          : null,
  };
  const document = {
    hidden: false,
    querySelector: (selector) =>
      selector === "[data-notifications-bell]" ? bell : null,
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
  };
  const calls = [];
  const queue = [...responses];
  const fetch = (url, options) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  let nextId = 1;
  const setTimeout = (fn, ms) => {
    timers.push({ id: nextId, fn, ms });
    nextId += 1;
    return nextId - 1;
  };
  const clearTimeout = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  load({ document, fetch, setTimeout, clearTimeout });
  return { document, badge, label, calls, timers, listeners };
}

const json = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("the bell", () => {
  test("asks at once, shows the count, and asks again after 30 seconds", async () => {
    const p = page({ responses: [json(200, { unread: 3 })] });
    await settle();
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].url).toBe("/api/notifications/count");
    expect(p.calls[0].options).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(p.badge.textContent).toBe("3");
    expect(p.badge.hidden).toBe(false);
    expect(p.label.textContent).toBe("Notifications, 3 unread");
    expect(p.timers).toHaveLength(1);
    expect(p.timers[0].ms).toBe(30000);
  });

  test("zero hides the badge", async () => {
    const p = page({ responses: [json(200, { unread: 0 })] });
    await settle();
    expect(p.badge.hidden).toBe(true);
    expect(p.label.textContent).toBe("Notifications");
  });

  test("a hidden tab does not schedule another ask; coming back asks at once", async () => {
    const p = page({
      responses: [json(200, { unread: 1 }), json(200, { unread: 4 })],
    });
    p.document.hidden = true;
    await settle();
    expect(p.timers).toHaveLength(0); // the first ask finished while hidden
    p.document.hidden = false;
    p.listeners.visibilitychange();
    await settle();
    expect(p.calls).toHaveLength(2);
    expect(p.badge.textContent).toBe("4");
    expect(p.timers).toHaveLength(1);
  });

  test("going hidden cancels the pending ask", async () => {
    const p = page({ responses: [json(200, { unread: 1 })] });
    await settle();
    expect(p.timers).toHaveLength(1);
    p.document.hidden = true;
    p.listeners.visibilitychange();
    expect(p.timers).toHaveLength(0);
  });

  test("signed out (401): keeps the last number and stops asking for good", async () => {
    const p = page({ responses: [json(401, { error: {} })] });
    await settle();
    expect(p.timers).toHaveLength(0);
    p.listeners.visibilitychange();
    await settle();
    expect(p.calls).toHaveLength(1);
    expect(p.badge.textContent).toBe("0");
  });

  test("a failed ask or an unusable answer keeps the number and tries again later", async () => {
    const p = page({
      responses: [new Error("offline"), json(500, {}), json(200, { unread: "x" })],
    });
    await settle();
    expect(p.badge.hidden).toBe(true);
    expect(p.timers).toHaveLength(1);
    p.timers[0].fn();
    await settle();
    p.timers[0].fn();
    await settle();
    expect(p.calls).toHaveLength(3);
    expect(p.badge.hidden).toBe(true);
    expect(p.timers).toHaveLength(1);
  });
});
