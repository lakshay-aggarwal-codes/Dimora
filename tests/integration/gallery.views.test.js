// P04-T03: the gallery and photo-manager markup, and the routes' guards. No
// database: partials are rendered directly, the detail page with a stubbed model.
const path = require("node:path");
const ejs = require("ejs");
const { createAgent } = require("../helpers/agent");
const { uploader, resetExternalMocks } = require("../helpers/mocks");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const { galleryOf } = require("../../src/services/images");
const { imageUrl } = require("../../src/utils/imageUrl");
const { formatMoney } = require("../../src/utils/money");

const PARTIALS = path.join(__dirname, "..", "..", "views", "partials");
const render = (name, locals) =>
  ejs.renderFile(path.join(PARTIALS, `${name}.ejs`), {
    imageUrl,
    formatMoney,
    csrfToken: "tok",
    ...locals,
  });
const squash = (html) => html.replace(/\s+/g, " ").trim();

const CLOUD = "https://res.cloudinary.com/demo/image/upload/v1/dimora_DEV";
const photos = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `64b0f0f0f0f0f0f0f0f0f0f${i}`,
    url: `${CLOUD}/p${i + 1}.jpg`,
    publicId: `dimora_DEV/p${i + 1}`,
    alt: "",
    caption: "",
    ...extra,
  }));

afterEach(() => {
  jest.restoreAllMocks();
  resetExternalMocks();
});

describe("gallery partial", () => {
  test("no photos: one decorative stock picture, no viewer, no script", async () => {
    const html = await render("gallery", { images: [], title: "Cottage" });
    expect(html).toContain(
      '<img class="gallery-main-img" src="https://images.unsplash.com',
    );
    expect(html).toContain('alt=""');
    expect(html).not.toMatch(/dialog|gallery\.js|data-gallery/);
  });

  test("one photo: main picture only, no thumbnails, no navigation buttons", async () => {
    const html = squash(
      await render("gallery", { images: photos(1), title: "Cottage" }),
    );
    expect(html).toContain(
      '<section class="gallery" data-gallery aria-label="Photos of Cottage">',
    );
    expect(html).toContain(
      'src="https://res.cloudinary.com/demo/image/upload/w_800,f_auto,q_auto/v1/dimora_DEV/p1.jpg"',
    );
    expect(html).toContain(
      'href="https://res.cloudinary.com/demo/image/upload/w_1600,f_auto,q_auto/v1/dimora_DEV/p1.jpg"',
    );
    expect(html).not.toContain("gallery-thumbs");
    expect(html).not.toContain("data-lightbox-prev");
    expect(html).not.toContain("Show all");
  });

  test("several photos: thumbnails, 'Show all N photos', previous and next", async () => {
    const html = squash(
      await render("gallery", { images: photos(4), title: "Cottage" }),
    );
    expect(html).toContain("Show all 4 photos");
    expect((html.match(/class="gallery-thumb"/g) || []).length).toBe(3);
    expect((html.match(/data-gallery-item/g) || []).length).toBe(4);
    expect(html).toContain("w_200,h_150,c_fill,f_auto,q_auto");
    expect(html).toContain("data-lightbox-prev");
    expect(html).toContain("data-lightbox-next");
    expect(html).toContain('<script src="/js/gallery.js" defer></script>');
  });

  test("every photo is a real link to the large picture (works without JavaScript)", async () => {
    const html = await render("gallery", {
      images: photos(3),
      title: "Cottage",
    });
    const links = html.match(/<a class="gallery-(?:main|thumb)" href="[^"]+"/g);
    expect(links).toHaveLength(3);
  });

  test("alt text: the host's text, else a generated one that says which photo it is", async () => {
    const html = await render("gallery", {
      images: [
        { ...photos(1)[0], alt: "Sunlit living room" },
        ...photos(2).slice(1),
      ],
      title: "Cottage",
    });
    expect(html).toContain('alt="Sunlit living room"');
    expect(html).toContain('data-alt="Cottage, photo 2 of 2"');
    expect(html).toContain('alt="Photo 2 of 2: Cottage, photo 2 of 2"');
  });

  test("the viewer is a labelled <dialog> with a live counter and caption", async () => {
    const html = await render("gallery", {
      images: photos(2),
      title: "Cottage",
    });
    expect(html).toMatch(
      /<dialog class="lightbox" data-lightbox aria-label="Photo viewer">/,
    );
    expect(html).toMatch(/data-lightbox-count aria-live="polite"/);
    expect(html).toMatch(/data-lightbox-caption aria-live="polite"/);
    expect(html).toMatch(
      /<button type="button" class="lightbox-button" data-lightbox-close>Close<\/button>/,
    );
  });

  test("alt text, captions and the title are escaped", async () => {
    const html = await render("gallery", {
      images: [
        {
          ...photos(1)[0],
          alt: '"><script>alert(1)</script>',
          caption: "<img src=x onerror=alert(1)>",
        },
      ],
      title: '"><b>x</b>',
    });
    expect(html).not.toMatch(/<script>alert|<img src=x|<b>x<\/b>/);
    expect(html).toContain("&lt;script&gt;");
  });

  test("a picture that is not on Cloudinary is used as it is", async () => {
    const html = await render("gallery", {
      images: [
        {
          id: "1",
          url: "https://images.unsplash.com/photo-1",
          alt: "",
          caption: "",
        },
      ],
      title: "T",
    });
    expect(html).toContain('src="https://images.unsplash.com/photo-1"');
  });
});

describe("photo manager partial", () => {
  const listing = { _id: "64b0f0f0f0f0f0f0f0f0aaaa" };
  const manager = (images, extra = {}) =>
    render("photo-manager", { listing, images, maxImages: 10, ...extra });
  const base = "/listings/64b0f0f0f0f0f0f0f0f0aaaa/images";

  test("each photo has details, move, cover and remove controls; the first is the cover", async () => {
    const html = squash(await manager(photos(3)));
    expect(html).toContain("3 of 10");
    expect(html).toContain("Photo 1 of 3");
    expect((html.match(/dim-badge-primary">Cover</g) || []).length).toBe(1);
    // photo 1: no earlier / cover; photo 3: no later
    expect((html.match(/value="earlier"/g) || []).length).toBe(2);
    expect((html.match(/value="later"/g) || []).length).toBe(2);
    expect((html.match(/>Make cover</g) || []).length).toBe(2);
    expect((html.match(/>Remove</g) || []).length).toBe(3);
    expect(html).toContain(
      `action="${base}/64b0f0f0f0f0f0f0f0f0f0f1/move?_method=PUT"`,
    );
    expect(html).toContain(
      `action="${base}/64b0f0f0f0f0f0f0f0f0f0f1/cover?_method=PUT"`,
    );
    expect(html).toContain(
      `action="${base}/64b0f0f0f0f0f0f0f0f0f0f1?_method=PUT"`,
    );
  });

  test("every control form carries the CSRF token", async () => {
    const html = await manager(photos(2));
    const forms = html.match(/<form [^>]*method="POST"/g).length;
    const tokens = html.match(/name="_csrf" value="tok"/g).length;
    expect(tokens).toBe(forms - 1); // the upload form's token is in its URL
    expect(html).toContain(
      `action="${base}?_csrf=tok" enctype="multipart/form-data"`,
    );
  });

  test("remove opens a confirmation dialog that submits DELETE", async () => {
    const html = squash(await manager(photos(2)));
    expect(html).toContain('data-bs-target="#remove-photo-0"');
    expect(html).toContain('id="remove-photo-1"');
    expect(html).toContain(
      `action="${base}/64b0f0f0f0f0f0f0f0f0f0f1?_method=DELETE"`,
    );
  });

  test("labels point at their inputs, and the file input says what is accepted", async () => {
    const html = await manager(photos(1));
    expect(html).toContain('for="alt-64b0f0f0f0f0f0f0f0f0f0f0"');
    expect(html).toContain('id="alt-64b0f0f0f0f0f0f0f0f0f0f0"');
    expect(html).toContain('for="caption-64b0f0f0f0f0f0f0f0f0f0f0"');
    expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(html).toContain('aria-describedby="photos-hint"');
    expect(html).toContain("You can add 9 more.");
  });

  test("a full gallery shows no upload form, only the limit message", async () => {
    const html = await manager(photos(10));
    expect(html).not.toContain('type="file"');
    expect(html).toContain("reached the limit of 10 photos");
  });

  test("no photos: just the upload form", async () => {
    const html = await manager([]);
    expect(html).not.toContain("photo-list");
    expect(html).toContain('type="file"');
    expect(html).toContain("0 of 10");
  });

  test("photos not yet upgraded (no ids) cannot be managed and the page says why", async () => {
    const html = await manager([{ ...photos(1)[0], id: "" }]);
    expect(html).not.toContain("photo-list");
    expect(html).toContain("npm run migrate");
  });

  test("the host's text is escaped in the inputs", async () => {
    const html = await manager([
      { ...photos(1)[0], alt: '"><script>x</script>', caption: "<b>c</b>" },
    ]);
    expect(html).not.toMatch(/<script>x|<b>c/);
  });
});

describe("detail page", () => {
  test("shows the listing's gallery, cover first, with the viewer script", async () => {
    const doc = new Listing(
      buildListingData({
        images: [
          {
            url: `${CLOUD}/b.jpg`,
            publicId: "dimora_DEV/b",
            alt: "Second",
            order: 1,
          },
          {
            url: `${CLOUD}/a.jpg`,
            publicId: "dimora_DEV/a",
            alt: "First",
            order: 0,
          },
        ],
      }),
    );
    const query = {
      populate: () => query,
      then: (res, rej) => Promise.resolve(doc).then(res, rej),
    };
    jest.spyOn(Listing, "findById").mockReturnValue(query);
    const res = await createAgent().get(`/listings/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text.indexOf("v1/dimora_DEV/a.jpg")).toBeLessThan(
      res.text.indexOf("v1/dimora_DEV/b.jpg"),
    );
    expect(res.text).toContain("Show all 2 photos");
    expect(res.text).toContain('src="/js/gallery.js"');
    expect(res.text).not.toMatch(/style="/);
    expect(galleryOf(doc).map((i) => i.alt)).toEqual(["First", "Second"]);
  });
});

describe("photo routes are guarded", () => {
  const id = "64b0f0f0f0f0f0f0f0f0aaaa";
  const img = "64b0f0f0f0f0f0f0f0f0bbbb";

  test.each([
    ["post", `/listings/${id}/images`],
    ["put", `/listings/${id}/images/order`],
    ["put", `/listings/${id}/images/${img}`],
    ["put", `/listings/${id}/images/${img}/cover`],
    ["put", `/listings/${id}/images/${img}/move`],
    ["delete", `/listings/${id}/images/${img}`],
  ])(
    "anonymous %s %s goes to the login page and uploads nothing",
    async (method, url) => {
      const res = await createAgent()[method](url).type("form").send({});
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login");
      expect(uploader.upload_stream).not.toHaveBeenCalled();
      expect(uploader.destroy).not.toHaveBeenCalled();
    },
  );

  test("a POST without the CSRF token is refused before anything else", async () => {
    const res = await createAgent({ csrf: false })
      .post(`/listings/${id}/images`)
      .attach("photos", Buffer.alloc(40), "a.jpg");
    expect(res.status).toBe(403);
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });
});
