// P18-T01: standing check on every <img> in the views: a described picture
// (alt), a reserved size (width and height, so the page does not jump when it
// loads) and a loading mode. New images that forget these fail here.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith(".ejs")) out.push(rel);
  }
  return out;
};

/** Every <img ...> of a view, with template code replaced by "EJS" so a ">" inside it cannot end the tag. */
function imageTags(file) {
  const source = fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/<%#[\s\S]*?%>/g, "")
    .replace(/<%[\s\S]*?%>/g, "EJS");
  return [...source.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
}

// Each exemption names the attributes it is excused from, and why.
const EXEMPT = [
  { match: /data-lightbox-img/, skip: ["width", "height", "loading"], why: "the viewer's picture: its source is set by gallery.js when it opens" },
  { match: /class="avatar /, skip: ["width", "height"], why: "round picture sized by the avatar classes" },
  { match: /class="gallery-main-img" src="EJS" alt="">/, skip: ["width", "height", "loading"], why: "stock fallback when a listing has no photo; markup pinned by an older test" },
];

describe("images in views", () => {
  const files = walk("views");
  const tags = files.flatMap((file) => imageTags(file).map((tag) => ({ file, tag })));

  test("the scan finds the pictures it should", () => {
    expect(tags.length > 8).toBe(true);
  });

  test("every <img> has alt, width, height and loading (unless exempt for a stated reason)", () => {
    const problems = [];
    for (const { file, tag } of tags) {
      const skipped = EXEMPT.filter((e) => e.match.test(tag)).flatMap((e) => e.skip);
      for (const attribute of ["alt", "width", "height", "loading"]) {
        if (skipped.includes(attribute)) continue;
        if (!new RegExp(`\\s${attribute}=`).test(tag)) problems.push(`${file}: missing ${attribute}: ${tag.slice(0, 80)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("the first picture of a listing page loads at once and ahead of the rest; the others wait", () => {
    const gallery = imageTags(path.join("views", "partials", "gallery.ejs"));
    const main = gallery.find((t) => /class="gallery-main-img" src="EJS" alt="EJS"/.test(t));
    expect(/loading="eager"/.test(main)).toBe(true);
    expect(/fetchpriority="high"/.test(main)).toBe(true);
    const thumb = gallery.find((t) => /^<img src="EJS" alt="Photo/.test(t));
    expect(/loading="lazy"/.test(thumb)).toBe(true);
    const card = imageTags(path.join("views", "partials", "listing-card.ejs"))[0];
    expect(/loading="lazy"/.test(card)).toBe(true);
    expect(/class="card-img-top listing-card-img" alt=""/.test(card)).toBe(true);
  });

  test("a loading mode is never anything but lazy or eager", () => {
    for (const { tag } of tags) {
      const mode = /loading="([^"]*)"/.exec(tag);
      if (mode) expect(["lazy", "eager"].includes(mode[1])).toBe(true);
    }
  });
});
