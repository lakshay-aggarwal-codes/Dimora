// P18-T01: the listing card's picture: right size, srcset, lazy, size reserved.
const path = require("node:path");
const ejs = require("ejs");
const { imageUrl, imageSrcset } = require("../../src/utils/imageUrl");
const { formatMoney } = require("../../src/utils/money");

const CARD = path.join(__dirname, "..", "..", "views", "partials", "listing-card.ejs");
const item = (extra = {}) => ({ id: "6720a0000000000000000001", title: "Sea house", imageUrl: null, location: "Goa", country: "India", priceMinor: 500000, currency: "INR", ...extra });
const render = (data, helpers = { imageUrl, imageSrcset }) =>
  ejs.renderFile(CARD, { formatMoney, ...helpers, item: data });
const imgTag = (html) => /<img [^>]*>/.exec(html)[0];

describe("listing card picture", () => {
  test("a Cloudinary photo: 800 px src, 400/800/1200 srcset, sizes, lazy, reserved size, empty alt", async () => {
    const tag = imgTag(await render(item({ imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/a.jpg" })));
    expect(tag).toContain('src="https://res.cloudinary.com/demo/image/upload/w_800,f_auto,q_auto/v1/a.jpg"');
    expect(tag).toContain("w_400,f_auto,q_auto/v1/a.jpg 400w");
    expect(tag).toContain("w_1200,f_auto,q_auto/v1/a.jpg 1200w");
    expect(tag).toContain('sizes="(min-width: 992px) 33vw, (min-width: 768px) 50vw, 100vw"');
    expect(tag).toContain('width="800" height="600"');
    expect(tag).toContain('loading="lazy"');
    expect(tag).toContain('decoding="async"');
    expect(tag).toContain('class="card-img-top listing-card-img" alt=""');
  });

  test("no photo: the stock picture is resized by srcset, its src stays the plain address", async () => {
    const tag = imgTag(await render(item()));
    expect(tag).toContain('src="https://images.unsplash.com/photo-1564013799919-ab600027ffc6"');
    expect(tag).toContain("w=400&amp;auto=format&amp;q=70 400w");
  });

  test("a photo from elsewhere has no srcset, only the plain src", async () => {
    const tag = imgTag(await render(item({ imageUrl: "https://a0.muscache.com/im/pictures/x.jpg" })));
    expect(tag).toContain('src="https://a0.muscache.com/im/pictures/x.jpg"');
    expect(tag).not.toContain("srcset");
    expect(tag).toContain('loading="lazy"');
  });

  test("a page without the helpers still renders the card", async () => {
    const tag = imgTag(await render(item({ imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/a.jpg" }), {}));
    expect(tag).toContain('src="https://res.cloudinary.com/demo/image/upload/v1/a.jpg"');
    expect(tag).not.toContain("srcset");
  });
});
