// Cloudinary delivery URLs (P04-T03). The stored URL is the original upload,
// which can be many megabytes; pages ask for a size that fits instead, in the
// format and quality the visitor's browser handles best (f_auto, q_auto).
//
//   imageUrl("https://res.cloudinary.com/x/image/upload/v1/a.jpg", "card")
//   -> "https://res.cloudinary.com/x/image/upload/w_800,f_auto,q_auto/v1/a.jpg"
//
// Anything that is not a Cloudinary upload URL (seed photos on Unsplash, a
// missing value) is returned unchanged, and a URL that already carries a
// transformation is not transformed twice.
const PRESETS = Object.freeze({
  card: "w_800,f_auto,q_auto", // cards and the main gallery picture
  thumb: "w_200,h_150,c_fill,f_auto,q_auto", // gallery thumbnails
  full: "w_1600,f_auto,q_auto", // the full-screen viewer
  edit: "w_250,f_auto,q_auto", // the host's photo manager
  avatar: "w_256,h_256,c_fill,g_auto,f_auto,q_auto", // profile pictures (square)
});

const UPLOAD = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/;
// "w_800,f_auto" or "c_fill,h_150": letters, underscore, value; comma separated.
const TRANSFORMATION = /^[a-z]{1,3}_[^/,]+(,[a-z]{1,3}_[^/,]+)*$/;

function imageUrl(url, preset = "card") {
  if (typeof url !== "string" || url === "") return "";
  if (!Object.hasOwn(PRESETS, preset)) {
    throw new Error(`imageUrl: unknown preset "${preset}"`);
  }
  const match = UPLOAD.exec(url);
  if (!match) return url;
  const [, base, rest] = match;
  const firstSegment = rest.split("/")[0];
  if (TRANSFORMATION.test(firstSegment)) return url; // already transformed
  return `${base}${PRESETS[preset]}/${rest}`;
}

const UNSPLASH_HOST = "images.unsplash.com";
const MIN_WIDTH = 100;
const MAX_WIDTH = 4000;

/**
 * The `srcset` of a picture: the same photo at several widths, so a phone
 * downloads a 400 px file and a large screen a 1200 px one (P18-T01).
 *   imageSrcset("https://res.cloudinary.com/x/image/upload/v1/a.jpg", [400, 800])
 *   -> "https://res.cloudinary.com/x/image/upload/w_400,f_auto,q_auto/v1/a.jpg 400w,
 *       https://res.cloudinary.com/x/image/upload/w_800,f_auto,q_auto/v1/a.jpg 800w"
 * Cloudinary uploads and the Unsplash seed photos are resized; any other URL, or
 * one that already carries a transformation, gives "" (the plain `src` is used).
 * @param {string} url
 * @param {number[]} [widths] whole numbers from 100 to 4000
 */
function imageSrcset(url, widths = [400, 800, 1200]) {
  if (
    !Array.isArray(widths) ||
    widths.length === 0 ||
    !widths.every((w) => Number.isInteger(w) && w >= MIN_WIDTH && w <= MAX_WIDTH)
  ) {
    throw new Error("imageSrcset: widths must be whole numbers from 100 to 4000");
  }
  if (typeof url !== "string" || url === "") return "";

  const cloud = UPLOAD.exec(url);
  if (cloud) {
    const [, base, rest] = cloud;
    if (TRANSFORMATION.test(rest.split("/")[0])) return "";
    return widths.map((w) => `${base}w_${w},f_auto,q_auto/${rest} ${w}w`).join(", ");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== UNSPLASH_HOST) return "";
  return widths
    .map((w) => {
      const sized = new URL(url);
      sized.searchParams.set("w", String(w));
      sized.searchParams.set("auto", "format");
      sized.searchParams.set("q", "70");
      return `${sized.toString()} ${w}w`;
    })
    .join(", ");
}

module.exports = { imageUrl, imageSrcset, PRESETS };
