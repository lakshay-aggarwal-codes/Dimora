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

module.exports = { imageUrl, PRESETS };
