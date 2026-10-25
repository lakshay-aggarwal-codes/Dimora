// P18-T01: the same photo at several widths.
const { imageSrcset, imageUrl } = require("../../src/utils/imageUrl");

const CLOUD = "https://res.cloudinary.com/demo/image/upload/v1699/dimora_DEV/abc.jpg";
const UNSPLASH = "https://images.unsplash.com/photo-1564013799919-ab600027ffc6";

describe("imageSrcset", () => {
  test("Cloudinary: one resized, auto-format, auto-quality URL per width", () => {
    expect(imageSrcset(CLOUD, [400, 800])).toBe(
      "https://res.cloudinary.com/demo/image/upload/w_400,f_auto,q_auto/v1699/dimora_DEV/abc.jpg 400w, " +
        "https://res.cloudinary.com/demo/image/upload/w_800,f_auto,q_auto/v1699/dimora_DEV/abc.jpg 800w",
    );
  });

  test("default widths are 400, 800 and 1200", () => {
    expect(imageSrcset(CLOUD).split(", ").map((c) => c.split(" ")[1])).toEqual(["400w", "800w", "1200w"]);
  });

  test("Unsplash seed photos are resized through their own parameters", () => {
    const set = imageSrcset(UNSPLASH, [400, 800]);
    expect(set).toBe(
      `${UNSPLASH}?w=400&auto=format&q=70 400w, ${UNSPLASH}?w=800&auto=format&q=70 800w`,
    );
  });

  test("an Unsplash URL that already has a query keeps it and changes only the width", () => {
    const set = imageSrcset(`${UNSPLASH}?crop=entropy&w=2000`, [400]);
    expect(set).toBe(`${UNSPLASH}?crop=entropy&w=400&auto=format&q=70 400w`);
  });

  test("anything else gives an empty string, so the plain src is used", () => {
    expect(imageSrcset("https://a0.muscache.com/im/pictures/x.jpg")).toBe("");
    expect(imageSrcset("http://images.unsplash.com/photo-1")).toBe(""); // not https
    expect(imageSrcset("https://evil.test/images.unsplash.com/x")).toBe("");
    expect(imageSrcset("not a url")).toBe("");
    expect(imageSrcset("")).toBe("");
    expect(imageSrcset(null)).toBe("");
    expect(imageSrcset(undefined)).toBe("");
  });

  test("an already transformed Cloudinary URL is not transformed twice", () => {
    expect(imageSrcset("https://res.cloudinary.com/demo/image/upload/w_300,c_fill/v1/a.jpg")).toBe("");
  });

  test("the widths are checked (a programming mistake is an error, not a bad page)", () => {
    for (const bad of [[], [0], [50], [99999], [400.5], ["400"], "400", null]) {
      let message = "";
      try {
        imageSrcset(CLOUD, bad);
      } catch (err) {
        message = err.message;
      }
      expect(message.includes("widths")).toBe(true);
    }
  });

  test("the plain src for the same photo is still the single preset URL", () => {
    expect(imageUrl(CLOUD, "card")).toBe(
      "https://res.cloudinary.com/demo/image/upload/w_800,f_auto,q_auto/v1699/dimora_DEV/abc.jpg",
    );
  });
});
