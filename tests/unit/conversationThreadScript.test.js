// public/js/conversation-thread.js: the pure helpers, and the polling and
// redraw loop against a fake document and fetch. Seeing a message arrive in a
// real browser is a manual check (docs/tasks/P11-T03.md).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "conversation-thread.js"),
  "utf8",
);

function load(extra = {}) {
  const context = { ...extra };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context;
}
const core = load().DimoraThreadCore;

describe("pollSeconds", () => {
  test("is 15 to 20 seconds, 15 by default", () => {
    expect(core.pollSeconds("15")).toBe(15);
    expect(core.pollSeconds("18")).toBe(18);
    expect(core.pollSeconds("5")).toBe(15);
    expect(core.pollSeconds("600")).toBe(20);
    expect(core.pollSeconds("abc")).toBe(15);
    expect(core.pollSeconds(null)).toBe(15);
    expect(core.pollSeconds("")).toBe(15);
  });
});

describe("parseMessages", () => {
  const good = { id: "a", body: "hi", mine: true };
  test("accepts a list of messages with an id, a text body and a mine flag", () => {
    expect(core.parseMessages({ messages: [good] })).toHaveLength(1);
    expect(core.parseMessages({ messages: [] })).toHaveLength(0);
  });
  test.each([
    null,
    undefined,
    "x",
    {},
    { messages: "x" },
    { messages: [{ id: 1, body: "x", mine: true }] },
    { messages: [{ id: "a", body: 5, mine: true }] },
    { messages: [{ id: "a", body: "x" }] },
    { messages: [null] },
    { error: { status: 401 } },
  ])("rejects %j", (body) => {
    expect(core.parseMessages(body)).toBeNull();
  });
});

describe("sameMessages", () => {
  test("is true only for the same ids in the same order", () => {
    expect(core.sameMessages(["a", "b"], [{ id: "a" }, { id: "b" }])).toBe(true);
    expect(core.sameMessages(["a"], [{ id: "a" }, { id: "b" }])).toBe(false);
    expect(core.sameMessages(["a", "b"], [{ id: "b" }, { id: "a" }])).toBe(false);
    expect(core.sameMessages([], [])).toBe(true);
  });
});

// ---- a fake page ------------------------------------------------------

function el(tag) {
  const node = {
    tag,
    children: [],
    attrs: {},
    className: "",
    textContent: "",
    hidden: false,
    setAttribute(k, v) {
      node.attrs[k] = v;
    },
    getAttribute: (k) => (k in node.attrs ? node.attrs[k] : null),
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      node.children = nodes;
    },
    get lastElementChild() {
      return node.children[node.children.length - 1] || null;
    },
  };
  return node;
}

function page({ responses, ids = [], url = "/api/conversations/c1/messages" }) {
  const listeners = {};
  const timers = [];
  const list = el("ol");
  list.attrs["data-other-name"] = "Hal <b>";
  if (url) list.attrs["data-messages-url"] = url;
  list.attrs["data-poll-seconds"] = "15";
  ids.forEach((id) => {
    const li = el("li");
    li.attrs["data-id"] = id;
    list.children.push(li);
  });
  const empty = el("p");
  const document = {
    hidden: false,
    body: undefined,
    querySelector: (s) =>
      s === "[data-message-list]" ? list : s === "[data-empty]" ? empty : null,
    createElement: el,
    createTextNode: (text) => ({ text }),
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
  };
  const calls = [];
  const queue = [...responses];
  const fetch = (u, options) => {
    calls.push({ u, options });
    const next = queue.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
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
  return { document, list, empty, calls, timers, listeners };
}

const json = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const msg = (id, body, mine = false) => ({ id, body, mine, when: "1 Oct", iso: "2026-10-01T00:00:00Z" });

describe("the thread page", () => {
  test("does nothing on an older page (no messages url)", async () => {
    const p = page({ responses: [], url: null });
    await settle();
    expect(p.calls).toHaveLength(0);
    expect(p.timers).toHaveLength(0);
  });

  test("waits 15 seconds before the first ask (the server already drew the page)", async () => {
    const p = page({ responses: [json(200, { messages: [] })], ids: ["a"] });
    expect(p.calls).toHaveLength(0);
    expect(p.timers).toHaveLength(1);
    expect(p.timers[0].ms).toBe(15000);
  });

  test("nothing new: the list is left alone", async () => {
    const p = page({
      responses: [json(200, { messages: [msg("a", "x")] })],
      ids: ["a"],
    });
    const before = p.list.children;
    p.timers[0].fn();
    await settle();
    expect(p.calls[0].u).toBe("/api/conversations/c1/messages");
    expect(p.calls[0].options).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(p.list.children).toBe(before);
    expect(p.timers).toHaveLength(1);
  });

  test("a new message redraws the list as text, never as HTML", async () => {
    const hostile = '<img src=x onerror=alert(1)> & "q"';
    const p = page({
      responses: [
        json(200, { messages: [msg("a", "old", true), msg("b", hostile)] }),
      ],
      ids: ["a"],
    });
    p.empty.hidden = false;
    p.timers[0].fn();
    await settle();
    expect(p.list.children).toHaveLength(2);
    const [first, second] = p.list.children;
    expect(first.className).toBe("message message-mine");
    expect(first.attrs["data-id"]).toBe("a");
    expect(second.className).toBe("message");
    const [meta, body] = second.children;
    expect(meta.children[0].textContent).toBe("Hal <b>"); // the other person's name, as text
    expect(meta.children[2].attrs.datetime).toBe("2026-10-01T00:00:00Z");
    expect(body.textContent).toBe(hostile); // set through textContent
    expect(body.children).toHaveLength(0);
    expect(p.empty.hidden).toBe(true);
    expect(p.timers).toHaveLength(1);
  });

  test("a hidden tab does not ask; coming back asks at once", async () => {
    const p = page({ responses: [json(200, { messages: [msg("a", "x")] })], ids: [] });
    p.document.hidden = true;
    p.listeners.visibilitychange();
    expect(p.timers).toHaveLength(0);
    p.document.hidden = false;
    p.listeners.visibilitychange();
    await settle();
    expect(p.calls).toHaveLength(1);
    expect(p.list.children).toHaveLength(1);
  });

  test("signed out (401) or no longer yours (404): stops for good", async () => {
    for (const status of [401, 404]) {
      const p = page({ responses: [json(status, {})], ids: ["a"] });
      p.timers[0].fn();
      await settle();
      expect(p.timers).toHaveLength(0);
      p.listeners.visibilitychange();
      await settle();
      expect(p.calls).toHaveLength(1);
      expect(p.list.children).toHaveLength(1);
    }
  });

  test("a failed ask or an unusable answer keeps what is shown and tries again later", async () => {
    const p = page({
      responses: [new Error("offline"), json(500, {}), json(200, { messages: "x" })],
      ids: ["a"],
    });
    const shown = p.list.children;
    for (let i = 0; i < 3; i += 1) {
      p.timers[0].fn();
      await settle();
    }
    expect(p.calls).toHaveLength(3);
    expect(p.list.children).toBe(shown);
    expect(p.timers).toHaveLength(1);
  });
});
