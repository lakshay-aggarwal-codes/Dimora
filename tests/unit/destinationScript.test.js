// P05-T06: public/js/destination-autocomplete.js in jsdom with a fake fetch.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "public", "js", "destination-autocomplete.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAN = { suggestions: [
  { label: "Panaji, Goa, India", dest: "Panaji, Goa, India", count: 3 },
  { label: "Panipat, Haryana, India", dest: "Panipat, Haryana, India", count: 1 },
] };

function setup(responder = () => PAN) {
  const dom = new JSDOM(
    `<!doctype html><body><form><label for="d">Where to?</label><input id="d" type="search" name="dest" data-destination-autocomplete><button>Go</button></form></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" },
  );
  const { window } = dom;
  const urls = [];
  window.fetch = (url, opts) => {
    urls.push(url);
    if (opts && opts.signal && opts.signal.aborted) return Promise.reject(new Error("aborted"));
    return Promise.resolve({ ok: true, json: async () => responder(url) });
  };
  window.eval(SOURCE);
  // jsdom reports "loading" while the page is parsed, so the script waits for this event; send it.
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const input = window.document.getElementById("d");
  const list = () => window.document.querySelector(".dest-ac-list");
  const type = async (text, wait = 320) => {
    input.focus();
    input.value = text;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(wait);
  };
  const key = (k) => {
    const e = new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    return e;
  };
  return { window, input, list, urls, type, key };
}

test("the input becomes an ARIA combobox that points at a listbox", () => {
  const { input, list } = setup();
  assert.equal(input.getAttribute("role"), "combobox");
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-autocomplete"), "list");
  assert.equal(input.getAttribute("aria-controls"), list().id);
  assert.equal(list().getAttribute("role"), "listbox");
  assert.equal(list().hidden, true);
  assert.match(list().getAttribute("aria-label"), /Where to\?/);
});

test("nothing is asked for one letter; two letters ask once after the pause, with the text encoded", async () => {
  const { type, urls } = setup();
  await type("p");
  assert.equal(urls.length, 0);
  await type("pa", 50);
  assert.equal(urls.length, 0, "debounced: not yet");
  await sleep(300);
  assert.deepEqual(urls, ["/api/destinations?q=pa"]);
  await type("São Paulo, B");
  assert.equal(urls[urls.length - 1], "/api/destinations?q=S%C3%A3o%20Paulo%2C%20B");
});

test("fast typing makes one request, for the last text", async () => {
  const { window, input, urls } = setup();
  input.focus();
  for (const t of ["pa", "pan", "pana"]) {
    input.value = t;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(60);
  }
  await sleep(320);
  assert.deepEqual(urls, ["/api/destinations?q=pana"]);
});

test("suggestions are listed as options with their counts, as text", async () => {
  const { input, list, type } = setup(() => ({ suggestions: [{ label: "<img src=x onerror=alert(1)>", dest: "x", count: 1 }] }));
  await type("xx");
  assert.equal(list().hidden, false);
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(list().querySelector("img"), null);
  assert.match(list().textContent, /<img src=x/);
  assert.match(list().textContent, /1 stay\b/);
});

test("arrow keys move through the options and Enter picks one without submitting", async () => {
  const { input, list, type, key, window } = setup();
  await type("pa");
  const options = list().querySelectorAll('[role="option"]');
  assert.equal(options.length, 2);
  key("ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), options[0].id);
  assert.equal(options[0].getAttribute("aria-selected"), "true");
  key("ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), options[1].id);
  key("ArrowDown"); // wraps
  assert.equal(input.getAttribute("aria-activedescendant"), options[0].id);
  key("ArrowUp"); // wraps back
  assert.equal(input.getAttribute("aria-activedescendant"), options[1].id);
  const enter = key("Enter");
  assert.equal(enter.defaultPrevented, true);
  assert.equal(input.value, "Panipat, Haryana, India");
  assert.equal(list().hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.ok(window.document.activeElement === input);
});

test("Enter with nothing highlighted still submits the form as before", async () => {
  const { type, key } = setup();
  await type("pa");
  assert.equal(key("Enter").defaultPrevented, false);
});

test("Escape closes the list and keeps what was typed", async () => {
  const { input, list, type, key } = setup();
  await type("pa");
  assert.equal(key("Escape").defaultPrevented, true);
  assert.equal(list().hidden, true);
  assert.equal(input.value, "pa");
});

test("a click (mousedown) on an option fills the box", async () => {
  const { input, list, type, window } = setup();
  await type("pa");
  list().querySelector('[role="option"]').dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  assert.equal(input.value, "Panaji, Goa, India");
});

test("an answer that arrives after the box changed or lost focus is ignored", async () => {
  const { input, list, type, window } = setup();
  await type("pa", 100);
  input.value = "zz";
  await sleep(300);
  // The answer for "pa" must not show for "zz" (the "zz" request returns the same fake list, so only check the focus rule).
  input.blur();
  await sleep(50);
  assert.equal(list().hidden, true);
  assert.ok(window.document.activeElement !== input);
});

test("an error or an empty answer leaves an ordinary field", async () => {
  const empty = setup(() => ({ suggestions: [] }));
  await empty.type("qq");
  assert.equal(empty.list().hidden, true);

  const { window, input, list } = setup();
  window.fetch = () => Promise.reject(new Error("offline"));
  input.focus();
  input.value = "pa";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(320);
  assert.equal(list().hidden, true);
});

test("a browser without fetch is left alone", () => {
  const dom = new JSDOM(`<input id="d" data-destination-autocomplete>`, { runScripts: "outside-only", url: "http://localhost/" });
  dom.window.fetch = undefined;
  dom.window.eval(SOURCE);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  assert.equal(dom.window.document.getElementById("d").getAttribute("role"), null);
});
