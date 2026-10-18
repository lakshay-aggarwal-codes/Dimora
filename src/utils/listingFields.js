// Small conversions between what the old listing form submits (rupees, free
// text place) and the v2 listing fields. The wizard (P04-T02) replaces the
// form, and with it most of this file.

/** Whole or fractional rupees -> integer paise. Returns null if not a number. */
function rupeesToMinor(rupees) {
  // An empty or blank string is "nothing typed", not zero rupees.
  if (typeof rupees === "string" && rupees.trim() === "") return null;
  const n = typeof rupees === "string" ? Number(rupees.trim()) : rupees;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Paise -> rupees for an input box: 250000 -> 2500, 123456 -> 1234.56. */
function minorToRupees(minor) {
  return Number.isInteger(minor) ? minor / 100 : null;
}

/** Best-effort structured address from the old location/country text. */
function addressFromLegacy(location, country) {
  const city = String(location ?? "").trim();
  const nation = String(country ?? "").trim();
  const address = {};
  if (city) address.city = city;
  if (nation) address.country = nation;
  return address;
}

/** The images[] entry for a stored cover image, or [] when there is none.
 *  (`filename` is the old name of the Cloudinary id; it becomes `publicId`.) */
function imagesFromCover(image) {
  if (!image || typeof image.url !== "string" || !image.url) return [];
  return [
    {
      url: image.url,
      publicId: image.filename || "",
      alt: "",
      caption: "",
      order: 0,
    },
  ];
}

module.exports = {
  rupeesToMinor,
  minorToRupees,
  addressFromLegacy,
  imagesFromCover,
};
