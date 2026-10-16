// P04-T03 through the real routes, with Cloudinary mocked. Needs a MongoDB
// (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const { uploader, resetExternalMocks } = require("../helpers/mocks");
const Listing = require("../../src/models/listing");

const pad = (head, total = 64) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(total - head.length)]);
const JPEG = () => pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = () => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const photo = (n) => ({
  url: `https://res.cloudinary.test/dimora_DEV/p${n}.jpg`,
  publicId: `dimora_DEV/p${n}`,
  alt: "",
  caption: "",
  order: n - 1,
});

async function ownerWithListing(overrides = {}) {
  const { user, password } = await createUser();
  const agent = await login(createAgent(), {
    username: user.username,
    password,
  });
  const listing = await createListing({
    owner: user._id,
    images: [photo(1), photo(2), photo(3)],
    ...overrides,
  });
  return { agent, user, listing };
}
const reload = (listing) => Listing.findById(listing._id);
const ids = (doc) => doc.images.map((i) => String(i._id));
const base = (listing) => `/listings/${listing._id}/images`;

afterEach(resetExternalMocks);

describeDb("photo routes", () => {
  useTestDb();

  test("upload adds photos at the end and shows a message on the edit page", async () => {
    const { agent, listing } = await ownerWithListing();
    const res = await agent
      .post(base(listing))
      .attach("photos", JPEG(), {
        filename: "a.jpg",
        contentType: "image/jpeg",
      })
      .attach("photos", PNG(), { filename: "b.png", contentType: "image/png" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/listings/${listing._id}/edit#photos`);
    const stored = await reload(listing);
    expect(stored.images).toHaveLength(5);
    expect(stored.images.map((i) => i.order)).toEqual([0, 1, 2, 3, 4]);
    expect(stored.images[3].publicId).toMatch(/^dimora_DEV\/image\d+$/);
    const page = await agent.get(`/listings/${listing._id}/edit`);
    expect(page.text).toContain("2 photos added.");
  });

  test("a text file named .jpg is refused and nothing is uploaded or stored", async () => {
    const { agent, listing } = await ownerWithListing();
    const res = await agent
      .post(base(listing))
      .attach("photos", Buffer.from("this is not an image, just text"), {
        filename: "fake.jpg",
        contentType: "image/jpeg",
      });
    expect(res.status).toBe(302);
    const page = await agent.get(`/listings/${listing._id}/edit`);
    expect(page.text).toMatch(
      /fake\.jpg&#34; is not a PNG, JPEG or WebP image/,
    );
    expect(uploader.upload_stream).not.toHaveBeenCalled();
    expect((await reload(listing)).images).toHaveLength(3);
  });

  test("an 11th photo is refused", async () => {
    const images = Array.from({ length: 10 }, (_, i) => photo(i + 1));
    const { agent, listing } = await ownerWithListing({ images });
    await agent
      .post(base(listing))
      .attach("photos", JPEG(), {
        filename: "a.jpg",
        contentType: "image/jpeg",
      });
    expect((await reload(listing)).images).toHaveLength(10);
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });

  test("a file over 5 MB is refused with 413", async () => {
    const { agent, listing } = await ownerWithListing();
    const big = Buffer.alloc(5 * 1024 * 1024 + 10);
    JPEG().copy(big);
    const res = await agent
      .post(base(listing))
      .attach("photos", big, {
        filename: "big.jpg",
        contentType: "image/jpeg",
      });
    expect(res.status).toBe(413);
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });

  test("reorder is stored and survives a reload", async () => {
    const { agent, listing } = await ownerWithListing();
    const [a, b, c] = ids(await reload(listing));
    const res = await agent
      .put(`${base(listing)}/order`)
      .type("form")
      .send({ order: [c, a, b] });
    expect(res.status).toBe(302);
    const stored = await reload(listing);
    expect(ids(stored)).toEqual([c, a, b]);
    expect(stored.images.map((i) => i.order)).toEqual([0, 1, 2]);
    expect(stored.image.filename).toBe("dimora_DEV/p3"); // the cover mirror follows
  });

  test("a stale order list is refused and changes nothing", async () => {
    const { agent, listing } = await ownerWithListing();
    const [a, b] = ids(await reload(listing));
    await agent
      .put(`${base(listing)}/order`)
      .type("form")
      .send({ order: [b, a] });
    expect(ids(await reload(listing))).toHaveLength(3);
    const page = await agent.get(`/listings/${listing._id}/edit`);
    expect(page.text).toContain("has changed");
  });

  test("move earlier / make cover", async () => {
    const { agent, listing } = await ownerWithListing();
    const [a, b, c] = ids(await reload(listing));
    await agent
      .put(`${base(listing)}/${b}/move`)
      .type("form")
      .send({ direction: "earlier" });
    expect(ids(await reload(listing))).toEqual([b, a, c]);
    await agent.put(`${base(listing)}/${c}/cover`);
    expect(ids(await reload(listing))).toEqual([c, b, a]);
  });

  test("alt text and caption are saved", async () => {
    const { agent, listing } = await ownerWithListing();
    const [a] = ids(await reload(listing));
    await agent
      .put(`${base(listing)}/${a}`)
      .type("form")
      .send({ alt: "Sunny room", caption: "The lounge" });
    const stored = await reload(listing);
    expect(stored.images[0].alt).toBe("Sunny room");
    expect(stored.images[0].caption).toBe("The lounge");
  });

  test("remove deletes the photo from the listing and from Cloudinary", async () => {
    const { agent, listing } = await ownerWithListing();
    const [, b] = ids(await reload(listing));
    const res = await agent.delete(`${base(listing)}/${b}`);
    expect(res.status).toBe(302);
    const stored = await reload(listing);
    expect(stored.images).toHaveLength(2);
    expect(stored.images.map((i) => i.publicId)).toEqual([
      "dimora_DEV/p1",
      "dimora_DEV/p3",
    ]);
    expect(uploader.destroy).toHaveBeenCalledWith("dimora_DEV/p2");
  });

  test("the last photo of a published listing cannot be removed", async () => {
    const { agent, listing } = await ownerWithListing({ images: [photo(1)] });
    const [a] = ids(await reload(listing));
    await agent.delete(`${base(listing)}/${a}`);
    expect((await reload(listing)).images).toHaveLength(1);
    expect(uploader.destroy).not.toHaveBeenCalled();
  });

  test("a listing with only the old `image` field keeps its cover when a photo is added", async () => {
    const { agent, listing } = await ownerWithListing({ images: [] });
    const oldUrl = (await reload(listing)).image.url;
    await agent
      .post(base(listing))
      .attach("photos", JPEG(), {
        filename: "a.jpg",
        contentType: "image/jpeg",
      });
    const stored = await reload(listing);
    expect(stored.images).toHaveLength(2);
    expect(stored.images[0].url).toBe(oldUrl);
  });

  test("another user cannot touch the photos (403) and nothing happens", async () => {
    const { listing } = await ownerWithListing();
    const { user: other, password } = await createUser();
    const agent = await login(createAgent(), {
      username: other.username,
      password,
    });
    const [a] = ids(await reload(listing));
    const attempts = [
      await agent
        .post(base(listing))
        .attach("photos", JPEG(), {
          filename: "a.jpg",
          contentType: "image/jpeg",
        }),
      await agent.delete(`${base(listing)}/${a}`),
      await agent.put(`${base(listing)}/${a}/cover`),
      await agent
        .put(`${base(listing)}/order`)
        .type("form")
        .send({ order: [a] }),
    ];
    for (const res of attempts) expect(res.status).toBe(403);
    expect((await reload(listing)).images).toHaveLength(3);
    expect(uploader.upload_stream).not.toHaveBeenCalled();
    expect(uploader.destroy).not.toHaveBeenCalled();
  });

  test("an unknown listing is a 404; an unknown or malformed photo id is a message, not a crash", async () => {
    const { agent, listing } = await ownerWithListing();
    expect(
      (
        await agent.delete(
          "/listings/64b0f0f0f0f0f0f0f0f0aaaa/images/64b0f0f0f0f0f0f0f0f0bbbb",
        )
      ).status,
    ).toBe(404);
    for (const bad of ["64b0f0f0f0f0f0f0f0f0bbbb", "not-an-id"]) {
      const res = await agent.delete(`${base(listing)}/${bad}`);
      expect(res.status).toBe(302);
    }
    const page = await agent.get(`/listings/${listing._id}/edit`);
    expect(page.text).toContain("That photo does not exist.");
  });

  test("the edit page lists the photos with their controls, the detail page shows the gallery", async () => {
    const { agent, listing } = await ownerWithListing();
    const edit = await agent.get(`/listings/${listing._id}/edit`);
    expect(edit.status).toBe(200);
    expect(edit.text).toContain("Photo 1 of 3");
    expect(edit.text).toContain("3 of 10");
    const show = await agent.get(`/listings/${listing._id}`);
    expect(show.text).toContain("Show all 3 photos");
  });

  test("the single-photo field on the old edit form replaces only the cover", async () => {
    const { agent, listing } = await ownerWithListing();
    const res = await agent
      .put(`/listings/${listing._id}`)
      .field("listing[title]", "Renamed")
      .field("listing[description]", "Desc")
      .field("listing[location]", "New Delhi")
      .field("listing[country]", "India")
      .field("listing[price]", "2500")
      .attach("listing[image][url]", PNG(), {
        filename: "n.png",
        contentType: "image/png",
      });
    expect(res.status).toBe(302);
    const stored = await reload(listing);
    expect(stored.images).toHaveLength(3);
    expect(stored.images[0].publicId).toMatch(/^dimora_DEV\/image\d+$/);
    expect(stored.images.slice(1).map((i) => i.publicId)).toEqual([
      "dimora_DEV/p2",
      "dimora_DEV/p3",
    ]);
    expect(uploader.destroy).toHaveBeenCalledWith("dimora_DEV/p1");
  });
});
