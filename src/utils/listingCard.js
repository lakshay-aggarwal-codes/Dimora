// Turns a stored listing (document or lean object) into the `item` the
// listing-card partial takes. Stored prices are whole rupees until P04-T01
// moves them to paise, so this is the one place that converts them.
function priceToMinor(price) {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
    return null;
  }
  return Math.round(price * 100);
}

function toCardItem(listing) {
  const doc = listing || {};
  return {
    id: String(doc._id ?? doc.id ?? ""),
    title: doc.title ?? "",
    imageUrl: doc.image && doc.image.url ? doc.image.url : null,
    location: doc.location,
    country: doc.country,
    priceMinor: priceToMinor(doc.price),
    currency: "INR",
  };
}

module.exports = { toCardItem, priceToMinor };
