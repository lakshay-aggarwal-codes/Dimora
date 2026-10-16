// Listing photos (P04-T03): checking uploads, storing them, and keeping the
// gallery in order.
//
// A listing's photos live in `listing.images` (see the model). The array order
// is the display order; `order` mirrors it and images[0] is the cover. The old
// `listing.image` field is a mirror of the cover that older pages still read;
// every function here keeps it in step (syncCover).
//
// Uploads are checked BEFORE anything is sent to Cloudinary: size, count and
// the file's real first bytes (the browser-supplied type and the file name
// prove nothing). If any upload fails, the ones that succeeded are deleted
// again and nothing is saved; if the save fails, the uploads are deleted.
const { AppError, ValidationError, NotFoundError } = require("../utils/errors");
const {
  uploadBuffer,
  deleteImage,
  MAX_IMAGE_BYTES,
} = require("../config/cloudinary");

const MAX_IMAGES = 10;
const TEXT_MAX = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const ID_PATTERN = /^[0-9a-f]{24}$/i;
const LIMIT_LABEL = `${MAX_IMAGE_BYTES / (1024 * 1024)} MB`;

class UploadFailedError extends AppError {
  constructor(
    message = "We could not upload your photos just now. Nothing was saved; please try again.",
    options,
  ) {
    super(502, message, { code: "upload_failed", ...options });
  }
}

// ---- Looking at a file --------------------------------------------------

/** "jpeg" | "png" | "webp" from the first bytes of a file, else null. */
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer[0] === 0x89 &&
    buffer.toString("latin1", 1, 4) === "PNG" &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function displayName(file) {
  const raw =
    file && typeof file.originalname === "string" ? file.originalname : "";
  const clean = raw.replace(CONTROL_CHARS, "").trim().slice(0, 60);
  return clean ? `"${clean}"` : "That file";
}

/** Throws a ValidationError (a message for the host) unless `file` is a real,
 *  small-enough PNG, JPEG or WebP. `file` is a multer memory file. */
function assertValidImage(file) {
  const name = displayName(file);
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new ValidationError(
      `${name} could not be read. Please choose it again.`,
    );
  }
  if (file.buffer.length === 0) {
    throw new ValidationError(`${name} is empty.`);
  }
  if (file.buffer.length > MAX_IMAGE_BYTES) {
    throw new ValidationError(`${name} is too large (maximum ${LIMIT_LABEL}).`);
  }
  if (!detectImageType(file.buffer)) {
    throw new ValidationError(`${name} is not a PNG, JPEG or WebP image.`);
  }
}

// ---- Keeping the gallery tidy -------------------------------------------

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

function plainText(value, label) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be text.`);
  }
  const clean = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (clean.length > TEXT_MAX) {
    throw new ValidationError(
      `${label} can be at most ${TEXT_MAX} characters.`,
    );
  }
  return clean;
}

/** A listing saved before the gallery existed has a cover in `image` and an
 *  empty images[]: bring that cover into images[] before changing anything. */
function adoptLegacyCover(listing) {
  if (listing.images.length === 0 && listing.image && listing.image.url) {
    listing.images.push({
      url: listing.image.url,
      publicId: listing.image.filename || "",
      alt: "",
      caption: "",
      order: 0,
    });
  }
}

/** The old `image` field mirrors the cover. */
function syncCover(listing) {
  const cover = listing.images[0];
  listing.set("image.url", cover ? cover.url : undefined);
  listing.set(
    "image.filename",
    cover && cover.publicId ? cover.publicId : undefined,
  );
}

/** order = position, then the cover mirror. Call after every change. */
function normalize(listing) {
  listing.images.sort(byOrder);
  listing.images.forEach((image, index) => {
    image.order = index;
  });
  syncCover(listing);
}

function prepare(listing) {
  adoptLegacyCover(listing);
  listing.images.sort(byOrder);
}

function findImage(listing, imageId) {
  const id = String(imageId ?? "");
  const image = ID_PATTERN.test(id)
    ? listing.images.find((item) => String(item._id) === id)
    : undefined;
  if (!image) throw new NotFoundError("That photo does not exist.");
  return image;
}

/** What the pages show: [{ id, url, publicId, alt, caption }], cover first.
 *  Falls back to the old `image` field for a listing not yet migrated. */
function galleryOf(listing) {
  const images = (listing && listing.images ? [...listing.images] : [])
    .filter((item) => item && item.url)
    .sort(byOrder)
    .map((item) => ({
      id: String(item._id ?? ""),
      url: item.url,
      publicId: item.publicId || "",
      alt: item.alt || "",
      caption: item.caption || "",
    }));
  if (images.length === 0 && listing && listing.image && listing.image.url) {
    return [
      {
        id: "",
        url: listing.image.url,
        publicId: listing.image.filename || "",
        alt: "",
        caption: "",
      },
    ];
  }
  return images;
}

// ---- Uploading ------------------------------------------------------------

/** Sends every file to Cloudinary. If one fails, the others are deleted again
 *  and an UploadFailedError is thrown (nothing is left behind). */
async function uploadAll(files, log) {
  const settled = await Promise.allSettled(
    files.map((file) => uploadBuffer(file.buffer)),
  );
  const uploaded = settled
    .filter((item) => item.status === "fulfilled")
    .map((item) => item.value);
  const failure = settled.find((item) => item.status === "rejected");
  if (failure) {
    await Promise.all(uploaded.map((item) => deleteImage(item.public_id, log)));
    if (log) log.warn({ err: failure.reason }, "photo upload failed");
    throw new UploadFailedError(undefined, { cause: failure.reason });
  }
  return uploaded.map((item) => ({
    url: item.secure_url,
    publicId: item.public_id,
  }));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Adds uploaded files to the end of the gallery (the first photo of an empty
 *  gallery becomes the cover). All-or-nothing. Returns the new entries. */
async function addImages(listing, files, { log } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new ValidationError("Choose at least one photo to upload.");
  }
  prepare(listing);
  const room = MAX_IMAGES - listing.images.length;
  if (files.length > room) {
    throw new ValidationError(
      room <= 0
        ? `This listing already has the maximum of ${MAX_IMAGES} photos. Remove one to add another.`
        : `You can add ${plural(room, "more photo")} (a listing can have at most ${MAX_IMAGES}).`,
    );
  }
  files.forEach(assertValidImage); // every file, before anything is uploaded

  const uploaded = await uploadAll(files, log);
  const start = listing.images.length;
  for (const item of uploaded) {
    listing.images.push({
      ...item,
      alt: "",
      caption: "",
      order: listing.images.length,
    });
  }
  normalize(listing);
  try {
    await listing.save();
  } catch (err) {
    await Promise.all(uploaded.map((item) => deleteImage(item.publicId, log)));
    throw err;
  }
  return listing.images.slice(start);
}

/** Removes a photo. The cover passes to the next photo. A published listing
 *  keeps at least one. The Cloudinary copy is deleted after the save. */
async function removeImage(listing, imageId, { log } = {}) {
  prepare(listing);
  const image = findImage(listing, imageId);
  if (listing.status === "published" && listing.images.length <= 1) {
    throw new ValidationError(
      "A published listing needs at least one photo. Add another one before removing this one.",
    );
  }
  const { publicId } = image;
  listing.images.pull(image._id);
  normalize(listing);
  await listing.save();
  await deleteImage(publicId, log); // best effort; never throws
  return { publicId };
}

/** Puts the photos in the order given (every photo's id, exactly once). */
async function reorderImages(listing, orderedIds) {
  prepare(listing);
  const current = listing.images.map((item) => String(item._id));
  const wanted = Array.isArray(orderedIds) ? orderedIds.map(String) : null;
  if (
    !wanted ||
    wanted.length !== current.length ||
    new Set(wanted).size !== wanted.length ||
    !wanted.every((id) => current.includes(id))
  ) {
    throw new ValidationError(
      "The list of photos has changed. Reload the page and try again.",
    );
  }
  wanted.forEach((id, index) => {
    listing.images.find((item) => String(item._id) === id).order = index;
  });
  normalize(listing);
  await listing.save();
  return galleryOf(listing);
}

/** direction: "earlier" or "later". At either end it does nothing. */
async function moveImage(listing, imageId, direction) {
  if (direction !== "earlier" && direction !== "later") {
    throw new ValidationError(
      "Choose whether to move the photo earlier or later.",
    );
  }
  prepare(listing);
  const image = findImage(listing, imageId);
  const ids = listing.images.map((item) => String(item._id));
  const from = ids.indexOf(String(image._id));
  const to = direction === "earlier" ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return galleryOf(listing);
  [ids[from], ids[to]] = [ids[to], ids[from]];
  return reorderImages(listing, ids);
}

/** Makes a photo the cover (moves it to the front). */
async function setCover(listing, imageId) {
  prepare(listing);
  const image = findImage(listing, imageId);
  const ids = listing.images.map((item) => String(item._id));
  const rest = ids.filter((id) => id !== String(image._id));
  return reorderImages(listing, [String(image._id), ...rest]);
}

/** Sets the alt text and/or caption of a photo (only the fields given). */
async function updateImageText(listing, imageId, { alt, caption } = {}) {
  prepare(listing);
  const image = findImage(listing, imageId);
  if (alt !== undefined) image.alt = plainText(alt, "The description");
  if (caption !== undefined) image.caption = plainText(caption, "The caption");
  await listing.save();
  return image;
}

/** The single-photo edit form: puts an already uploaded file in as the cover
 *  and returns the Cloudinary id of the cover it replaced (or undefined), for
 *  the caller to delete once the listing is saved. Nothing is saved here. */
function replaceCover(listing, { url, publicId }) {
  prepare(listing);
  const previous = listing.images[0];
  const previousPublicId = previous
    ? previous.publicId
    : listing.image && listing.image.filename;
  if (previous) listing.images.shift();
  listing.images.unshift({ url, publicId, alt: "", caption: "", order: 0 });
  normalize(listing);
  return previousPublicId || undefined;
}

module.exports = {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  TEXT_MAX,
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
  syncCover,
};
