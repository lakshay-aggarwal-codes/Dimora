// schema.org JSON-LD for a public listing page (P04-T07). Returned as the
// text of a <script type="application/ld+json"> element. The JSON is made safe
// to put inside HTML: < > & and the line separators are written as \u escapes,
// so a title like "</script><script>" cannot end the element.
//
// Only what is already public goes in: the street address and the exact point
// are NOT included (the city, state and country are).
const { imageUrl } = require("./imageUrl");
const { formatMoney } = require("./money");
const { amenityLabel } = require("./amenities");

const MAX_DESCRIPTION = 500;
const MAX_IMAGES = 10;

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const clip = (text, max) => {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};

/**
 * @param {object} listing  a Listing document or plain object
 * @param {object} extras   { gallery: [{url}], rating: { average, count } }
 * @returns {string} JSON text, safe inside a script element
 */
function listingJsonLd(listing, { gallery = [], rating } = {}) {
  const address = listing.address || {};
  const data = {
    "@context": "https://schema.org",
    "@type": "LodgingBusiness",
    name: clip(listing.title, 200),
  };
  const description = clip(listing.description, MAX_DESCRIPTION);
  if (description) data.description = description;

  const images = gallery
    .filter((item) => item && item.url)
    .slice(0, MAX_IMAGES)
    .map((item) => imageUrl(item.url, "full"));
  if (images.length) data.image = images;

  const place = {
    "@type": "PostalAddress",
    addressLocality: address.city || undefined,
    addressRegion: address.state || undefined,
    addressCountry: address.country || listing.country || undefined,
  };
  if (place.addressLocality || place.addressRegion || place.addressCountry) {
    data.address = place;
  }

  const nightly = listing.pricing && listing.pricing.nightlyMinor;
  if (Number.isInteger(nightly) && nightly > 0) {
    data.priceRange = `${formatMoney(nightly, listing.pricing.currency || "INR")} per night`;
  }

  const features = (listing.amenities || [])
    .map(amenityLabel)
    .filter(Boolean)
    .map((name) => ({
      "@type": "LocationFeatureSpecification",
      name,
      value: true,
    }));
  if (features.length) data.amenityFeature = features;

  if (rating && rating.count > 0 && rating.average !== null) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: rating.average,
      reviewCount: rating.count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return safeJson(data);
}

module.exports = { listingJsonLd, safeJson };
