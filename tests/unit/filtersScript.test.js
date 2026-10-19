// public/js/filters.js in a Node vm with a tiny fake DOM (no browser, no jsdom).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "filters.js"),
  "utf8",
);

function element(extra = {}) {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  return {
    attrs,
    classes,
    listeners,
    textContent: "",
    hidden: true,
    setAttribute(name, value) {
      attrs[name] = value;
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type, event = {}) {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
    ...extra,
  };
}

function run({ withResults = true } = {}) {
  const results = withResults ? element() : null;
  const status = withResults ? element() : null;
  const searchForm = element();
  const panelForm = element();
  const docListeners = {};
  const winListeners = {};
  const document = {
    getElementById: (id) => ({ results, "search-status": status })[id] || null,
    querySelectorAll: () => [searchForm, panelForm],
    addEventListener: (type, fn) => {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
  };
  const window = {
    addEventListener: (type, fn) => {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
  };
  vm.runInNewContext(SOURCE, { document, window, Array });
  const click = (event) => (docListeners.click || []).forEach((fn) => fn(event));
  const linkIn = (selectorMatches, target = "") => ({
    target: {
      closest: (selector) =>
        selector === "a[href]"
          ? { target, closest: (s) => (selectorMatches && s.includes(".filter-chips") ? {} : null) }
          : null,
    },
    button: 0,
  });
  return {
    results,
    status,
    searchForm,
    panelForm,
    click,
    linkIn,
    pageshow: (event) => (winListeners.pageshow || []).forEach((fn) => fn(event)),
  };
}

describe("filters.js", () => {
  test("does nothing on a page without a results area", () => {
    const page = run({ withResults: false });
    expect(page.searchForm.listeners.submit).toBeUndefined();
  });

  test("submitting the search form or the filter panel marks the results busy", () => {
    for (const name of ["searchForm", "panelForm"]) {
      const page = run();
      page[name].fire("submit");
      expect(page.results.attrs["aria-busy"]).toBe("true");
      expect(page.results.classes.has("is-loading")).toBe(true);
      expect(page.status.textContent).toBe("Updating results\u2026");
      expect(page.status.hidden).toBe(false);
    }
  });

  test("a click on a chip, category or page link marks the results busy", () => {
    const page = run();
    page.click(page.linkIn(true));
    expect(page.results.attrs["aria-busy"]).toBe("true");
  });

  test("a link elsewhere on the page does not", () => {
    const page = run();
    page.click(page.linkIn(false));
    expect(page.results.attrs["aria-busy"]).toBeUndefined();
  });

  test("a click that opens a new tab or window is left alone", () => {
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const page = run();
      page.click({ ...page.linkIn(true), ...extra });
      expect(page.results.attrs["aria-busy"]).toBeUndefined();
    }
    const page = run();
    page.click(page.linkIn(true, "_blank"));
    expect(page.results.attrs["aria-busy"]).toBeUndefined();
    page.click({ ...page.linkIn(true), defaultPrevented: true });
    expect(page.results.attrs["aria-busy"]).toBeUndefined();
  });

  test("coming back from the browser's cache clears the busy state", () => {
    const page = run();
    page.searchForm.fire("submit");
    page.pageshow({ persisted: false });
    expect(page.results.attrs["aria-busy"]).toBe("true");
    page.pageshow({ persisted: true });
    expect(page.results.attrs["aria-busy"]).toBeUndefined();
    expect(page.results.classes.has("is-loading")).toBe(false);
    expect(page.status.hidden).toBe(true);
    expect(page.status.textContent).toBe("");
  });
});
