// How each sample listing is classified for the category strip (P05-T04):
// property type, setting (vibe) and whether it has a pool. Kept next to, not
// inside, seed-data.js so the sample text stays as it was. A title that is not
// listed here gets no classification (it appears under no category).
// Values come from src/config/constants.js.
const BASE_AMENITIES = ["wifi", "kitchen"];

const CLASSIFICATION = {
  "Cozy Beachfront Cottage": { propertyType: "cottage", vibe: "beach" },
  "Modern Loft in Downtown": { propertyType: "apartment", vibe: "city" },
  "Mountain Retreat": { propertyType: "cabin", vibe: "mountain" },
  "Historic Villa in Tuscany": { propertyType: "villa", vibe: "countryside", pool: true },
  "Secluded Treehouse Getaway": { propertyType: "cabin", vibe: "countryside" },
  "Beachfront Paradise": { propertyType: "villa", vibe: "beach", pool: true },
  "Rustic Cabin by the Lake": { propertyType: "cabin", vibe: "lake" },
  "Luxury Penthouse with City Views": { propertyType: "apartment", vibe: "city" },
  "Ski-In/Ski-Out Chalet": { propertyType: "cabin", vibe: "mountain" },
  "Safari Lodge in the Serengeti": { propertyType: "hotel", vibe: "countryside" },
  "Historic Canal House": { propertyType: "house", vibe: "city" },
  "Private Island Retreat": { propertyType: "villa", vibe: "beach", pool: true },
  "Charming Cottage in the Cotswolds": { propertyType: "cottage", vibe: "countryside" },
  "Historic Brownstone in Boston": { propertyType: "house", vibe: "city" },
  "Beachfront Bungalow in Bali": { propertyType: "house", vibe: "beach" },
  "Mountain View Cabin in Banff": { propertyType: "cabin", vibe: "mountain" },
  "Art Deco Apartment in Miami": { propertyType: "apartment", vibe: "city" },
  "Tropical Villa in Phuket": { propertyType: "villa", vibe: "beach", pool: true },
  "Historic Castle in Scotland": { propertyType: "other", vibe: "countryside" },
  "Desert Oasis in Dubai": { propertyType: "villa", vibe: "desert", pool: true },
  "Rustic Log Cabin in Montana": { propertyType: "cabin", vibe: "mountain" },
  "Beachfront Villa in Greece": { propertyType: "villa", vibe: "beach", pool: true },
  "Eco-Friendly Treehouse Retreat": { propertyType: "cabin", vibe: "countryside" },
  "Historic Cottage in Charleston": { propertyType: "cottage", vibe: "city" },
  "Modern Apartment in Tokyo": { propertyType: "apartment", vibe: "city" },
  "Lakefront Cabin in New Hampshire": { propertyType: "cabin", vibe: "lake" },
  "Luxury Villa in the Maldives": { propertyType: "villa", vibe: "beach", pool: true },
  "Ski Chalet in Aspen": { propertyType: "cabin", vibe: "mountain" },
  "Secluded Beach House in Costa Rica": { propertyType: "house", vibe: "beach" },
};

/** The fields to add to a sample listing, or {} when its title is not listed. */
function classificationFor(title) {
  const entry = Object.hasOwn(CLASSIFICATION, title) ? CLASSIFICATION[title] : null;
  if (!entry) return {};
  return {
    propertyType: entry.propertyType,
    roomType: "entire_place",
    vibe: entry.vibe,
    amenities: entry.pool ? [...BASE_AMENITIES, "pool"] : [...BASE_AMENITIES],
  };
}

module.exports = { CLASSIFICATION, classificationFor };
