// Turns a stored listing (document or lean object) into the `item` the
// listing-card partial takes. Prices are integer paise (listing.pricing).
function nightlyMinor(doc) {
  const minor = doc.pricing && doc.pricing.nightlyMinor;
  return Number.isInteger(minor) && minor >= 0 ? minor : null;
}

function toCardItem(listing) {
  const doc = listing || {};
  return {
    id: String(doc._id ?? doc.id ?? ""),
    title: doc.title ?? "",
    imageUrl: doc.image && doc.image.url ? doc.image.url : null,
    location: doc.location,
    country: doc.country,
    priceMinor: nightlyMinor(doc),
    currency: (doc.pricing && doc.pricing.currency) || "INR",
  };
}

module.exports = { toCardItem };
