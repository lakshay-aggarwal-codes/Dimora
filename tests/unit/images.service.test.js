// P04-T03: the photo service, without a database. Listing documents are real
// Mongoose documents with save() stubbed; Cloudinary is the jest mock, so the
// tests can see exactly what was uploaded and deleted.
const { uploader, resetExternalMocks } = require("../helpers/mocks");
const { buildListingData } = require("../helpers/factories");
const Listing = require("../../src/models/listing");
const {
  MAX_IMAGES,
  UploadFailedError,
  detectImageType,
  assertValidImage,
  galleryOf,
  addImages,
  removeImage,
  reorderImages,
  moveImage,
  setCover,
  updateImageText,
  replaceCover,
} = require("../../src/services/images");
const { ValidationError, NotFoundError } = require("../../src/utils/errors");

// ---- Files ---------------------------------------------------------------
const pad = (head, total = 64) =>
  Buffer.concat([
    Buffer.from(head),
    Buffer.alloc(Math.max(0, total - head.length)),
  ]);
const JPEG = () => pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = () => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = () =>
  pad(
    Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
  );
const file = (buffer = JPEG(), originalname = "photo.jpg") => ({
  buffer,
  originalname,
  mimetype: "image/jpeg",
});

// ---- Listings ------------------------------------------------------------
const photo = (n, extra = {}) => ({
  url: `https://res.cloudinary.test/dimora_DEV/p${n}.jpg`,
  publicId: `dimora_DEV/p${n}`,
  alt: "",
  caption: "",
  order: n - 1,
  ...extra,
});
const listingWith = (count, overrides = {}) => {
  const images = Array.from({ length: count }, (_, i) => photo(i + 1));
  return new Listing(buildListingData({ images, ...overrides }));
};
const publicIds = (listing) => listing.images.map((i) => i.publicId);
const idOf = (listing, index) => String(listing.images[index]._id);

let save;
beforeEach(() => {
  save = jest.spyOn(Listing.prototype, "save").mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  resetExternalMocks();
});

describe("detectImageType (first bytes, not names)", () => {
  test.each([
    ["JPEG", JPEG(), "jpeg"],
    ["PNG", PNG(), "png"],
    ["WebP", WEBP(), "webp"],
  ])("recognises %s", (_name, buffer, type) => {
    expect(detectImageType(buffer)).toBe(type);
  });

  test.each([
    ["GIF", pad(Buffer.from("GIF89a"))],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["HTML", Buffer.from("<html><script>alert(1)</script></html>")],
    ["PDF", pad(Buffer.from("%PDF-1.7"))],
    ["plain text", Buffer.from("not an image at all")],
    ["Windows exe", pad(Buffer.from("MZ"))],
    ["a PNG signature cut short", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    [
      "RIFF that is not WebP (WAV)",
      pad(
        Buffer.concat([
          Buffer.from("RIFF"),
          Buffer.alloc(4),
          Buffer.from("WAVE"),
        ]),
      ),
    ],
    ["an empty buffer", Buffer.alloc(0)],
  ])("rejects %s", (_name, buffer) => {
    expect(detectImageType(buffer)).toBeNull();
  });

  test.each([undefined, null, "ffd8ff", 42, {}])(
    "rejects a non-buffer (%p)",
    (value) => {
      expect(detectImageType(value)).toBeNull();
    },
  );
});

describe("assertValidImage", () => {
  test("accepts real images of every supported type", () => {
    for (const buffer of [JPEG(), PNG(), WEBP()]) {
      expect(() => assertValidImage(file(buffer))).not.toThrow();
    }
  });

  test("a text file named photo.jpg is rejected (D-16: the name proves nothing)", () => {
    expect.assertions(3);
    try {
      assertValidImage(
        file(Buffer.from("this is just text, renamed"), "photo.jpg"),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe('"photo.jpg" is not a PNG, JPEG or WebP image.');
    }
  });

  test("a script or an HTML page with an image type is rejected", () => {
    for (const body of [
      "<script>alert(1)</script>",
      "<!DOCTYPE html><html></html>",
    ]) {
      expect(() =>
        assertValidImage({ ...file(Buffer.from(body)), mimetype: "image/png" }),
      ).toThrow(/not a PNG, JPEG or WebP/);
    }
  });

  test("a real PNG with the wrong name or declared type is accepted (bytes decide)", () => {
    expect(() =>
      assertValidImage({
        buffer: PNG(),
        originalname: "notes.txt",
        mimetype: "text/plain",
      }),
    ).not.toThrow();
  });

  test("5 MB is the limit: exactly 5 MB passes, one byte more does not", () => {
    const limit = 5 * 1024 * 1024;
    const big = (size) => {
      const buffer = Buffer.alloc(size);
      JPEG().copy(buffer);
      return buffer;
    };
    expect(() => assertValidImage(file(big(limit)))).not.toThrow();
    expect(() => assertValidImage(file(big(limit + 1), "huge.jpg"))).toThrow(
      '"huge.jpg" is too large (maximum 5 MB).',
    );
  });

  test("empty, missing or unreadable files", () => {
    expect(() => assertValidImage(file(Buffer.alloc(0)))).toThrow(/is empty/);
    expect(() => assertValidImage({ originalname: "a.jpg" })).toThrow(
      /could not be read/,
    );
    expect(() => assertValidImage(undefined)).toThrow(/could not be read/);
    expect(() => assertValidImage({ buffer: "text" })).toThrow(
      /could not be read/,
    );
  });

  test("the file name in the message is shortened and stripped of control characters", () => {
    const evil = `${"a".repeat(100)}\n\u0000<b>.jpg`;
    try {
      assertValidImage(file(Buffer.from("x".repeat(30)), evil));
    } catch (err) {
      expect(err.message.includes("\n")).toBe(false);
      expect(err.message.includes("\u0000")).toBe(false);
      expect(err.message.length).toBeLessThan(120);
    }
    expect.assertions(3);
  });

  test("no name -> 'That file'", () => {
    expect(() =>
      assertValidImage({ buffer: Buffer.from("x".repeat(30)) }),
    ).toThrow(/^That file is not/);
  });
});

describe("addImages", () => {
  test("uploads every file, saves once, and numbers the photos in order", async () => {
    const listing = listingWith(2);
    const added = await addImages(listing, [
      file(JPEG()),
      file(PNG(), "b.png"),
      file(WEBP(), "c.webp"),
    ]);
    expect(uploader.upload_stream).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(1);
    expect(listing.images).toHaveLength(5);
    expect(listing.images.map((i) => i.order)).toEqual([0, 1, 2, 3, 4]);
    expect(added).toHaveLength(3);
    expect(added[0].url).toMatch(
      /^https:\/\/res\.cloudinary\.test\/dimora_DEV\/image\d+\.jpg$/,
    );
    expect(added[0].publicId).toMatch(/^dimora_DEV\/image\d+$/);
    expect(added.every((i) => i.alt === "" && i.caption === "")).toBe(true);
    // the cover (and its mirror) is unchanged
    expect(listing.images[0].publicId).toBe("dimora_DEV/p1");
    expect(listing.image.filename).toBe("dimora_DEV/p1");
  });

  test("uploads with the format allow-list, so Cloudinary refuses other types too", async () => {
    await addImages(listingWith(0), [file()]);
    expect(uploader.upload_stream.mock.calls[0][0]).toEqual({
      folder: "dimora_DEV",
      resource_type: "image",
      allowed_formats: ["jpg", "png", "webp"],
    });
  });

  test("the first photo of an empty gallery becomes the cover and fills the old image field", async () => {
    const listing = new Listing(buildListingData({ image: undefined }));
    expect(listing.images).toHaveLength(0);
    await addImages(listing, [file()]);
    expect(listing.images[0].order).toBe(0);
    expect(listing.image.url).toBe(listing.images[0].url);
    expect(listing.image.filename).toBe(listing.images[0].publicId);
  });

  test("an old listing's cover (only in `image`) is kept as photo 1", async () => {
    const listing = new Listing(buildListingData()); // image set, images empty
    const oldUrl = listing.image.url;
    await addImages(listing, [file()]);
    expect(listing.images).toHaveLength(2);
    expect(listing.images[0].url).toBe(oldUrl);
    expect(listing.images[0].publicId).toBe(listing.toObject().image.filename);
  });

  test("the limit is 10 photos: 10 + 1 is refused before anything is uploaded", async () => {
    expect(MAX_IMAGES).toBe(Listing.MAX_IMAGES);
    const listing = listingWith(10);
    await expect(addImages(listing, [file()])).rejects.toThrow(
      /maximum of 10 photos/,
    );
    expect(uploader.upload_stream).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(listing.images).toHaveLength(10);
  });

  test("11 files at once on an empty listing are refused", async () => {
    const files = Array.from({ length: 11 }, () => file());
    await expect(addImages(listingWith(0), files)).rejects.toThrow(
      /at most 10/,
    );
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });

  test("exactly filling the gallery works (8 + 2 = 10)", async () => {
    const listing = listingWith(8);
    await addImages(listing, [file(), file()]);
    expect(listing.images).toHaveLength(10);
  });

  test("the message says how many more fit", async () => {
    await expect(
      addImages(listingWith(8), [file(), file(), file()]),
    ).rejects.toThrow(
      "You can add 2 more photos (a listing can have at most 10).",
    );
    await expect(addImages(listingWith(9), [file(), file()])).rejects.toThrow(
      "You can add 1 more photo (a listing can have at most 10).",
    );
  });

  test("one bad file among good ones: nothing is uploaded and nothing saved", async () => {
    const listing = listingWith(1);
    const fake = file(Buffer.from("definitely not an image"), "fake.jpg");
    await expect(addImages(listing, [file(), fake, file()])).rejects.toThrow(
      /"fake.jpg" is not a PNG/,
    );
    expect(uploader.upload_stream).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(listing.images).toHaveLength(1);
  });

  test("one oversized file among good ones is refused the same way", async () => {
    const huge = Buffer.alloc(5 * 1024 * 1024 + 1);
    JPEG().copy(huge);
    await expect(
      addImages(listingWith(0), [file(), file(huge, "huge.jpg")]),
    ).rejects.toThrow(/too large/);
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });

  test("no files / not a list", async () => {
    for (const files of [[], undefined, null, "x"]) {
      await expect(addImages(listingWith(0), files)).rejects.toThrow(
        /Choose at least one photo/,
      );
    }
  });

  test("partial upload failure: the photos that did upload are deleted, nothing is saved", async () => {
    uploader.upload_stream
      .mockImplementationOnce((options, cb) => ({
        end: () =>
          setImmediate(() =>
            cb(null, {
              secure_url: "https://res.cloudinary.test/dimora_DEV/ok1.jpg",
              public_id: "dimora_DEV/ok1",
            }),
          ),
      }))
      .mockImplementationOnce((options, cb) => ({
        end: () => setImmediate(() => cb(new Error("network down"))),
      }))
      .mockImplementationOnce((options, cb) => ({
        end: () =>
          setImmediate(() =>
            cb(null, {
              secure_url: "https://res.cloudinary.test/dimora_DEV/ok3.jpg",
              public_id: "dimora_DEV/ok3",
            }),
          ),
      }));
    const listing = listingWith(1);
    const log = { warn: jest.fn() };
    const error = await addImages(listing, [file(), file(), file()], {
      log,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(UploadFailedError);
    expect(error.statusCode).toBe(502);
    expect(error.message).toMatch(/Nothing was saved/);
    expect(error.message).not.toMatch(/network down/);
    expect(uploader.destroy.mock.calls.map((c) => c[0]).sort()).toEqual([
      "dimora_DEV/ok1",
      "dimora_DEV/ok3",
    ]);
    expect(save).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  test("every upload fails: nothing to clean up, nothing saved", async () => {
    const failing = (options, cb) => ({
      end: () => setImmediate(() => cb(new Error("boom"))),
    });
    uploader.upload_stream
      .mockImplementationOnce(failing)
      .mockImplementationOnce(failing);
    await expect(
      addImages(listingWith(0), [file(), file()]),
    ).rejects.toBeInstanceOf(UploadFailedError);
    expect(uploader.destroy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test("if saving fails after uploading, every upload is deleted and the error is rethrown", async () => {
    save.mockRejectedValueOnce(new Error("db down"));
    await expect(addImages(listingWith(1), [file(), file()])).rejects.toThrow(
      "db down",
    );
    expect(uploader.destroy).toHaveBeenCalledTimes(2);
    for (const call of uploader.destroy.mock.calls) {
      expect(call[0]).toMatch(/^dimora_DEV\/image\d+$/);
    }
  });
});

describe("removeImage", () => {
  test("removes the photo, renumbers, saves, then deletes it from Cloudinary", async () => {
    const listing = listingWith(3);
    await removeImage(listing, idOf(listing, 1));
    expect(publicIds(listing)).toEqual(["dimora_DEV/p1", "dimora_DEV/p3"]);
    expect(listing.images.map((i) => i.order)).toEqual([0, 1]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(uploader.destroy).toHaveBeenCalledTimes(1);
    expect(uploader.destroy).toHaveBeenCalledWith("dimora_DEV/p2");
    // the save happened before the Cloudinary delete
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      uploader.destroy.mock.invocationCallOrder[0],
    );
  });

  test("removing the cover makes the next photo the cover (and updates the old image field)", async () => {
    const listing = listingWith(2);
    await removeImage(listing, idOf(listing, 0));
    expect(listing.images[0].publicId).toBe("dimora_DEV/p2");
    expect(listing.image.url).toBe(
      "https://res.cloudinary.test/dimora_DEV/p2.jpg",
    );
    expect(listing.image.filename).toBe("dimora_DEV/p2");
  });

  test("a published listing keeps its last photo", async () => {
    const listing = listingWith(1);
    await expect(removeImage(listing, idOf(listing, 0))).rejects.toThrow(
      /needs at least one photo/,
    );
    expect(listing.images).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
    expect(uploader.destroy).not.toHaveBeenCalled();
  });

  test("a draft may lose its last photo; the old image field is cleared", async () => {
    const listing = listingWith(1, { status: "draft" });
    await removeImage(listing, idOf(listing, 0));
    expect(listing.images).toHaveLength(0);
    expect(listing.image.url).toBeUndefined();
    expect(listing.image.filename).toBeUndefined();
  });

  test("an unknown or malformed id is a 404-type error and changes nothing", async () => {
    const listing = listingWith(2);
    for (const id of [
      "64b0f0f0f0f0f0f0f0f0f0f0",
      "nope",
      "",
      undefined,
      null,
      "../../x",
    ]) {
      await expect(removeImage(listing, id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
    expect(listing.images).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
    expect(uploader.destroy).not.toHaveBeenCalled();
  });

  test("a picture that is not ours (seed data) is dropped without calling Cloudinary", async () => {
    const listing = listingWith(2);
    listing.images[1].publicId = "listingimage";
    await removeImage(listing, idOf(listing, 1));
    expect(uploader.destroy).not.toHaveBeenCalled();
  });

  test("a failed Cloudinary delete does not undo the removal or throw", async () => {
    uploader.destroy.mockRejectedValueOnce(new Error("cloudinary down"));
    const listing = listingWith(2);
    const log = { warn: jest.fn() };
    await expect(
      removeImage(listing, idOf(listing, 1), { log }),
    ).resolves.toEqual({ publicId: "dimora_DEV/p2" });
    expect(listing.images).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();
  });

  test("if the save fails, nothing is deleted from Cloudinary", async () => {
    save.mockRejectedValueOnce(new Error("db down"));
    const listing = listingWith(2);
    await expect(removeImage(listing, idOf(listing, 1))).rejects.toThrow(
      "db down",
    );
    expect(uploader.destroy).not.toHaveBeenCalled();
  });
});

describe("reordering", () => {
  test("reorderImages stores the new order and the cover follows", async () => {
    const listing = listingWith(3);
    const [a, b, c] = [0, 1, 2].map((i) => idOf(listing, i));
    const result = await reorderImages(listing, [c, a, b]);
    expect(publicIds(listing)).toEqual([
      "dimora_DEV/p3",
      "dimora_DEV/p1",
      "dimora_DEV/p2",
    ]);
    expect(listing.images.map((i) => i.order)).toEqual([0, 1, 2]);
    expect(listing.image.filename).toBe("dimora_DEV/p3");
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.map((i) => i.publicId)).toEqual(publicIds(listing));
  });

  test("the order survives a reload (read back by `order`, not by position)", async () => {
    const listing = listingWith(3);
    const ids = [0, 1, 2].map((i) => idOf(listing, i));
    await reorderImages(listing, [ids[1], ids[2], ids[0]]);
    // simulate a document whose array comes back in a different order
    const stored = listing.toObject().images.reverse();
    const reloaded = new Listing(buildListingData({ images: stored }));
    expect(galleryOf(reloaded).map((i) => i.publicId)).toEqual([
      "dimora_DEV/p2",
      "dimora_DEV/p3",
      "dimora_DEV/p1",
    ]);
  });

  test.each([
    ["a photo missing", (ids) => ids.slice(1)],
    ["a photo twice", (ids) => [ids[0], ids[0], ids[1]]],
    ["an unknown id", (ids) => [ids[0], ids[1], "64b0f0f0f0f0f0f0f0f0f0f0"]],
    ["an extra id", (ids) => [...ids, "64b0f0f0f0f0f0f0f0f0f0f0"]],
    ["nothing", () => []],
  ])("refuses a list with %s", async (_label, make) => {
    const listing = listingWith(3);
    const ids = [0, 1, 2].map((i) => idOf(listing, i));
    await expect(reorderImages(listing, make(ids))).rejects.toThrow(
      /has changed/,
    );
    expect(publicIds(listing)).toEqual([
      "dimora_DEV/p1",
      "dimora_DEV/p2",
      "dimora_DEV/p3",
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  test.each([undefined, null, "abc", { 0: "x" }, 7])(
    "refuses %p as the list",
    async (value) => {
      await expect(reorderImages(listingWith(2), value)).rejects.toBeInstanceOf(
        ValidationError,
      );
    },
  );

  test("moveImage swaps with the neighbour; at either end it does nothing", async () => {
    const listing = listingWith(3);
    await moveImage(listing, idOf(listing, 1), "earlier");
    expect(publicIds(listing)).toEqual([
      "dimora_DEV/p2",
      "dimora_DEV/p1",
      "dimora_DEV/p3",
    ]);
    await moveImage(listing, idOf(listing, 1), "later");
    expect(publicIds(listing)).toEqual([
      "dimora_DEV/p2",
      "dimora_DEV/p3",
      "dimora_DEV/p1",
    ]);
    save.mockClear();
    await moveImage(listing, idOf(listing, 0), "earlier"); // already first
    await moveImage(listing, idOf(listing, 2), "later"); // already last
    expect(publicIds(listing)).toEqual([
      "dimora_DEV/p2",
      "dimora_DEV/p3",
      "dimora_DEV/p1",
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  test("moveImage needs a real direction and a real photo", async () => {
    const listing = listingWith(2);
    await expect(
      moveImage(listing, idOf(listing, 0), "sideways"),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      moveImage(listing, idOf(listing, 0), undefined),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      moveImage(listing, "64b0f0f0f0f0f0f0f0f0f0f0", "later"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("setCover moves a photo to the front and keeps the rest in order", async () => {
    const listing = listingWith(4);
    await setCover(listing, idOf(listing, 2));
    expect(publicIds(listing)).toEqual([
      "dimora_DEV/p3",
      "dimora_DEV/p1",
      "dimora_DEV/p2",
      "dimora_DEV/p4",
    ]);
    expect(listing.image.filename).toBe("dimora_DEV/p3");
    expect(listing.images.map((i) => i.order)).toEqual([0, 1, 2, 3]);
  });

  test("setCover on the cover changes nothing important and does not fail", async () => {
    const listing = listingWith(2);
    await setCover(listing, idOf(listing, 0));
    expect(publicIds(listing)).toEqual(["dimora_DEV/p1", "dimora_DEV/p2"]);
  });

  test("a listing whose array and `order` disagree is put right before it is changed", async () => {
    const listing = new Listing(
      buildListingData({
        images: [
          photo(1, { order: 2 }),
          photo(2, { order: 0 }),
          photo(3, { order: 1 }),
        ],
      }),
    );
    await moveImage(listing, idOf(listing, 0), "later"); // array position 0 is "p1", displayed last
    expect(publicIds(listing).sort()).toEqual([
      "dimora_DEV/p1",
      "dimora_DEV/p2",
      "dimora_DEV/p3",
    ]);
    expect(listing.images.map((i) => i.order)).toEqual([0, 1, 2]);
  });
});

describe("updateImageText", () => {
  test("sets alt and caption, trimmed and with whitespace collapsed", async () => {
    const listing = listingWith(2);
    const image = await updateImageText(listing, idOf(listing, 1), {
      alt: "  A sunny   terrace\nwith chairs ",
      caption: "  The terrace  ",
    });
    expect(image.alt).toBe("A sunny terrace with chairs");
    expect(image.caption).toBe("The terrace");
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("only the fields that are given change", async () => {
    const listing = new Listing(
      buildListingData({ images: [photo(1, { alt: "keep", caption: "old" })] }),
    );
    await updateImageText(listing, idOf(listing, 0), { caption: "new" });
    expect(listing.images[0].alt).toBe("keep");
    expect(listing.images[0].caption).toBe("new");
  });

  test("control characters become spaces; markup is kept as text (views escape it)", async () => {
    const listing = listingWith(1);
    const image = await updateImageText(listing, idOf(listing, 0), {
      alt: "a\u0000b\u0007c <b>x</b>",
    });
    expect(image.alt).toBe("a b c <b>x</b>");
  });

  test("200 characters is allowed, 201 is not", async () => {
    const listing = listingWith(1);
    await updateImageText(listing, idOf(listing, 0), { alt: "a".repeat(200) });
    await expect(
      updateImageText(listing, idOf(listing, 0), { alt: "a".repeat(201) }),
    ).rejects.toThrow(/at most 200 characters/);
    await expect(
      updateImageText(listing, idOf(listing, 0), { caption: "a".repeat(201) }),
    ).rejects.toThrow(/caption can be at most 200/);
  });

  test.each([[{ alt: 5 }], [{ alt: ["x"] }], [{ caption: { a: 1 } }]])(
    "refuses non-text %j",
    async (value) => {
      const listing = listingWith(1);
      await expect(
        updateImageText(listing, idOf(listing, 0), value),
      ).rejects.toBeInstanceOf(ValidationError);
    },
  );

  test("an empty string clears the text", async () => {
    const listing = new Listing(
      buildListingData({ images: [photo(1, { alt: "x" })] }),
    );
    await updateImageText(listing, idOf(listing, 0), { alt: "   " });
    expect(listing.images[0].alt).toBe("");
  });
});

describe("replaceCover (the single-photo edit field)", () => {
  test("puts the new photo first, drops the old cover, returns its id, leaves the rest", () => {
    const listing = listingWith(3);
    const previous = replaceCover(listing, {
      url: "https://res.cloudinary.test/dimora_DEV/new.jpg",
      publicId: "dimora_DEV/new",
    });
    expect(previous).toBe("dimora_DEV/p1");
    expect(publicIds(listing)).toEqual([
      "dimora_DEV/new",
      "dimora_DEV/p2",
      "dimora_DEV/p3",
    ]);
    expect(listing.image.filename).toBe("dimora_DEV/new");
    expect(save).not.toHaveBeenCalled(); // the controller saves
  });

  test("a listing with only the old `image` field", () => {
    const listing = new Listing(buildListingData()); // image set, images empty
    const oldId = listing.toObject().image.filename;
    expect(
      replaceCover(listing, {
        url: "https://x/new.jpg",
        publicId: "dimora_DEV/new",
      }),
    ).toBe(oldId);
    expect(publicIds(listing)).toEqual(["dimora_DEV/new"]);
  });

  test("a listing with no photo at all returns nothing to delete", () => {
    const listing = new Listing(buildListingData({ image: undefined }));
    expect(
      replaceCover(listing, {
        url: "https://x/new.jpg",
        publicId: "dimora_DEV/new",
      }),
    ).toBeUndefined();
    expect(listing.images).toHaveLength(1);
  });
});

describe("galleryOf", () => {
  test("cover first, by `order`", () => {
    const listing = new Listing(
      buildListingData({
        images: [photo(1, { order: 1 }), photo(2, { order: 0 })],
      }),
    );
    expect(galleryOf(listing).map((i) => i.publicId)).toEqual([
      "dimora_DEV/p2",
      "dimora_DEV/p1",
    ]);
  });

  test("gives ids, alt and caption as strings", () => {
    const listing = new Listing(
      buildListingData({ images: [photo(1, { alt: "A", caption: "C" })] }),
    );
    const [first] = galleryOf(listing);
    expect(first).toEqual({
      id: String(listing.images[0]._id),
      url: "https://res.cloudinary.test/dimora_DEV/p1.jpg",
      publicId: "dimora_DEV/p1",
      alt: "A",
      caption: "C",
    });
  });

  test("a listing not yet upgraded falls back to its old `image`", () => {
    const listing = new Listing(buildListingData());
    const gallery = galleryOf(listing);
    expect(gallery).toHaveLength(1);
    expect(gallery[0].url).toBe(listing.image.url);
    expect(gallery[0].id).toBe("");
  });

  test("no photo at all, or a missing listing, is an empty list", () => {
    expect(
      galleryOf(new Listing(buildListingData({ image: undefined }))),
    ).toEqual([]);
    expect(galleryOf(undefined)).toEqual([]);
    expect(galleryOf(null)).toEqual([]);
  });
});
