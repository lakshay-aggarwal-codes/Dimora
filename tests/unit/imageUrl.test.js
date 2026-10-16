// P04-T03: Cloudinary size/format presets
const { imageUrl, PRESETS } = require("../../src/utils/imageUrl");

const BASE = "https://res.cloudinary.com/demo/image/upload";

describe("imageUrl", () => {
  test("card preset inserts w_800,f_auto,q_auto before the version", () => {
    expect(imageUrl(`${BASE}/v1699/dimora_DEV/abc.jpg`, "card")).toBe(
      `${BASE}/w_800,f_auto,q_auto/v1699/dimora_DEV/abc.jpg`,
    );
  });
  test("card is the default", () => {
    expect(imageUrl(`${BASE}/v1/a.jpg`)).toBe(
      `${BASE}/w_800,f_auto,q_auto/v1/a.jpg`,
    );
  });
  test.each(Object.keys(PRESETS))("preset %s is applied", (name) => {
    expect(imageUrl(`${BASE}/v1/a.jpg`, name)).toBe(
      `${BASE}/${PRESETS[name]}/v1/a.jpg`,
    );
  });
  test("a URL without a version still works", () => {
    expect(imageUrl(`${BASE}/dimora_DEV/a.png`, "thumb")).toBe(
      `${BASE}/${PRESETS.thumb}/dimora_DEV/a.png`,
    );
  });
  test("an already transformed URL is not transformed twice", () => {
    const done = `${BASE}/w_800,f_auto,q_auto/v1/a.jpg`;
    expect(imageUrl(done, "full")).toBe(done);
    expect(imageUrl(imageUrl(`${BASE}/v1/a.jpg`, "card"), "card")).toBe(
      `${BASE}/w_800,f_auto,q_auto/v1/a.jpg`,
    );
    expect(imageUrl(`${BASE}/c_fill,h_150/v1/a.jpg`, "card")).toBe(
      `${BASE}/c_fill,h_150/v1/a.jpg`,
    );
  });
  test("pictures that are not Cloudinary uploads are left alone", () => {
    for (const url of [
      "https://images.unsplash.com/photo-1564013799919-ab600027ffc6",
      "https://res.cloudinary.com.evil.example/demo/image/upload/v1/a.jpg",
      "http://res.cloudinary.com/demo/image/upload/v1/a.jpg",
      "https://res.cloudinary.com/demo/video/upload/v1/a.mp4",
      "/relative/a.jpg",
    ]) {
      expect(imageUrl(url, "card")).toBe(url);
    }
  });
  test("missing values give an empty string", () => {
    for (const v of [undefined, null, "", 5, {}]) expect(imageUrl(v)).toBe("");
  });
  test("an unknown preset is a programming error", () => {
    expect(() => imageUrl(`${BASE}/v1/a.jpg`, "huge")).toThrow(
      /unknown preset/,
    );
    expect(() => imageUrl(`${BASE}/v1/a.jpg`, "__proto__")).toThrow(
      /unknown preset/,
    );
  });
  test("presets only contain safe transformation characters", () => {
    for (const value of Object.values(PRESETS))
      expect(value).toMatch(/^[a-z0-9_,]+$/);
  });
});
