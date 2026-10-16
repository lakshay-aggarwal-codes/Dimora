// public/js/gallery.js in a Node vm with a tiny fake DOM (no browser, no jsdom).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "gallery.js"),
  "utf8",
);

function el(extra = {}) {
  const listeners = {};
  const attrs = {};
  return {
    listeners,
    attrs,
    textContent: "",
    dataset: {},
    focused: 0,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type, event = {}) {
      const e = {
        preventDefault() {
          e.prevented = true;
        },
        target: this,
        ...event,
      };
      (listeners[type] || []).forEach((fn) => fn(e));
      return e;
    },
    setAttribute(name, value) {
      attrs[name] = value;
    },
    getAttribute(name) {
      return attrs[name];
    },
    focus() {
      this.focused += 1;
    },
    ...extra,
  };
}

function run({ photos = 3, supportsDialog = true, noRoot = false } = {}) {
  const links = Array.from({ length: photos }, (_, i) => {
    const a = el({
      dataset: { alt: `Alt ${i + 1}`, caption: i === 1 ? "A caption" : "" },
    });
    a.attrs.href = `/full/${i + 1}.jpg`;
    return a;
  });
  const parts = {
    img: el(),
    caption: el(),
    count: el(),
    close: el(),
    prev: photos > 1 ? el() : null,
    next: photos > 1 ? el() : null,
  };
  const dialog = el({
    opened: 0,
    closed: 0,
    showModal() {
      this.opened += 1;
    },
    close() {
      this.closed += 1;
      this.fire("close");
    },
    querySelector(sel) {
      return (
        {
          "[data-lightbox-img]": parts.img,
          "[data-lightbox-caption]": parts.caption,
          "[data-lightbox-count]": parts.count,
          "[data-lightbox-close]": parts.close,
          "[data-lightbox-prev]": parts.prev,
          "[data-lightbox-next]": parts.next,
        }[sel] || null
      );
    },
  });
  if (!supportsDialog) delete dialog.showModal;
  const root = {
    querySelector: (sel) => (sel === "dialog[data-lightbox]" ? dialog : null),
    querySelectorAll: () => links,
  };
  const document = {
    querySelector: (sel) => (sel === "[data-gallery]" && !noRoot ? root : null),
  };
  vm.runInNewContext(SOURCE, { document });
  return { links, dialog, ...parts };
}

describe("gallery viewer", () => {
  test("clicking a photo opens the viewer on that photo instead of following the link", () => {
    const g = run();
    const event = g.links[1].fire("click");
    expect(event.prevented).toBe(true);
    expect(g.dialog.opened).toBe(1);
    expect(g.img.attrs.src).toBe("/full/2.jpg");
    expect(g.img.attrs.alt).toBe("Alt 2");
    expect(g.caption.textContent).toBe("A caption");
    expect(g.count.textContent).toBe("Photo 2 of 3");
  });

  test("Next/Previous move and wrap around", () => {
    const g = run();
    g.links[2].fire("click");
    g.next.fire("click");
    expect(g.count.textContent).toBe("Photo 1 of 3");
    g.prev.fire("click");
    expect(g.count.textContent).toBe("Photo 3 of 3");
    expect(g.img.attrs.src).toBe("/full/3.jpg");
  });

  test("arrow keys move; other keys do nothing", () => {
    const g = run();
    g.links[0].fire("click");
    const right = g.dialog.fire("keydown", { key: "ArrowRight" });
    expect(right.prevented).toBe(true);
    expect(g.count.textContent).toBe("Photo 2 of 3");
    g.dialog.fire("keydown", { key: "ArrowLeft" });
    g.dialog.fire("keydown", { key: "ArrowLeft" });
    expect(g.count.textContent).toBe("Photo 3 of 3");
    const other = g.dialog.fire("keydown", { key: "a" });
    expect(other.prevented).toBeUndefined();
    expect(g.count.textContent).toBe("Photo 3 of 3");
  });

  test("closing returns focus to the photo that was opened, and empties the image", () => {
    const g = run();
    g.links[1].fire("click");
    g.close.fire("click");
    expect(g.dialog.closed).toBe(1);
    expect(g.links[1].focused).toBe(1);
    expect(g.img.attrs.src).toBe("");
  });

  test("Escape (the browser closes the dialog and fires `close`) also returns focus", () => {
    const g = run();
    g.links[2].fire("click");
    g.dialog.fire("close");
    expect(g.links[2].focused).toBe(1);
  });

  test("a click on the backdrop closes; a click inside does not", () => {
    const g = run();
    g.links[0].fire("click");
    g.dialog.fire("click", { target: g.img });
    expect(g.dialog.closed).toBe(0);
    g.dialog.fire("click", { target: g.dialog });
    expect(g.dialog.closed).toBe(1);
  });

  test("a single photo: no arrow navigation, nothing breaks", () => {
    const g = run({ photos: 1 });
    g.links[0].fire("click");
    g.dialog.fire("keydown", { key: "ArrowRight" });
    expect(g.count.textContent).toBe("Photo 1 of 1");
  });

  test("a browser without <dialog> keeps the plain links (no handlers)", () => {
    const g = run({ supportsDialog: false });
    expect(g.links[0].listeners.click).toBeUndefined();
  });

  test("a page without a gallery is ignored", () => {
    expect(() => run({ noRoot: true })).not.toThrow();
  });

  test("the script never writes HTML", () => {
    expect(SOURCE).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/,
    );
  });
});
