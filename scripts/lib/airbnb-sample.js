// Maps one record of the public "sample_airbnb" dataset (listingsAndReviews.json,
// one JSON object per line, MongoDB extended JSON) to a Dimora v2 listing.
// Pure functions: no database, no network, so they are easy to test.
//
// Prices in the dataset are US dollars (assumed, not stated by the file); they
// are converted to INR paise at a rate the caller chooses (ADR-008, ADR-002).
// Reviews are NOT mapped: the source has no star rating and no real author, and
// Dimora reviews need a completed stay (ADR-010).
const { keysForListing } = require("../../src/utils/searchKeys");

/** Unwraps MongoDB extended JSON ({"$numberInt":"8"} -> 8, {"$date":..} -> Date). */
function unwrap(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  if ("$numberInt" in value) return Number(value.$numberInt);
  if ("$numberLong" in value) return Number(value.$numberLong);
  if ("$numberDouble" in value) return Number(value.$numberDouble);
  if ("$numberDecimal" in value) return Number(value.$numberDecimal);
  if ("$date" in value) {
    const inner = value.$date;
    const ms = typeof inner === "object" && inner ? Number(inner.$numberLong) : inner;
    return new Date(ms);
  }
  return value;
}

const num = (value) => {
  const n = unwrap(value);
  // The dataset stores some counts as strings ("2"), others as {$numberInt}.
  if (typeof n === "string" && n.trim() !== "") return Number.isFinite(Number(n)) ? Number(n) : null;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const text = (value, max) => {
  if (typeof value !== "string") return "";
  const t = value.replace(/\s+/g, " ").trim();
  return max ? t.slice(0, max) : t;
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const PROPERTY_TYPE = [
  [/villa/i, "villa"],
  [/cabin|chalet|treehouse|tiny house|hut/i, "cabin"],
  [/cottage|bungalow/i, "cottage"],
  [/farm|barn|ranch/i, "farm_stay"],
  [/hotel|hostel|bed and breakfast|guesthouse|guest suite|resort|aparthotel|lodge/i, "hotel"],
  [/apartment|condominium|loft|flat|serviced|townhouse|condo/i, "apartment"],
  [/house|home/i, "house"],
];
function propertyTypeOf(value) {
  const t = text(value);
  for (const [pattern, mapped] of PROPERTY_TYPE) if (pattern.test(t)) return mapped;
  return "other";
}

function roomTypeOf(value) {
  const t = text(value).toLowerCase();
  if (t.startsWith("private")) return "private_room";
  if (t.startsWith("shared")) return "shared_room";
  return "entire_place";
}

function cancellationOf(value) {
  const t = text(value).toLowerCase();
  if (t === "flexible") return "flexible";
  if (t.startsWith("strict") || t.startsWith("super_strict")) return "strict";
  return "moderate";
}

// Source amenity (lower-case) -> Dimora amenity value (src/config/constants.js).
const AMENITY = [
  [/^wifi$|^wireless internet$|^internet$/, "wifi"],
  [/^kitchen$/, "kitchen"],
  [/^washer$/, "washer"],
  [/^air conditioning$/, "air_conditioning"],
  [/^heating$/, "heating"],
  [/^(cable )?tv$/, "tv"],
  [/^laptop.friendly workspace$/, "workspace"],
  [/^free parking on premises$|^free street parking$/, "free_parking"],
  [/^pool$|^private pool$|^shared pool$/, "pool"],
  [/^gym$/, "gym"],
  [/^(private )?(balcony|patio)|^patio or balcony$/, "balcony"],
  [/^smoke (detector|alarm)$/, "smoke_alarm"],
  [/^first aid kit$/, "first_aid_kit"],
  [/^pets allowed$/, "pets_allowed"],
];
function amenitiesOf(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const t = text(raw).toLowerCase();
    for (const [pattern, value] of AMENITY) {
      if (pattern.test(t)) out.add(value);
    }
  }
  return [...out];
}

/** "Porto, Porto, Portugal" -> city/state/country; the dataset's `market` is the city when present. */
function addressOf(source) {
  const a = source.address || {};
  const parts = text(a.street)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const country = text(a.country, 100);
  const city = text(a.market, 100) || parts[0] || "";
  const state = parts.length >= 3 && parts[1] !== city ? text(parts[1], 100) : "";
  return { city, state, country };
}

/**
 * @param {object} source one parsed line of listingsAndReviews.json
 * @param {{ ownerId: any, usdToInr: number }} options
 * @returns {{ doc: object } | { skipped: string }} a listing document, or why it was skipped
 */
function mapListing(source, { ownerId, usdToInr }) {
  const id = text(String(unwrap(source._id) ?? ""));
  if (!id) return { skipped: "no id" };
  const title = text(source.name, 120);
  if (!title) return { skipped: "no title" };

  const coords = source.address?.location?.coordinates?.map(num);
  const [lng, lat] = coords || [];
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90 ||
    (lng === 0 && lat === 0)
  ) {
    return { skipped: "no usable coordinates" };
  }

  const usd = num(source.price);
  if (!usd || usd <= 0) return { skipped: "no price" };
  const nightlyMinor = Math.round(usd * usdToInr) * 100; // whole rupees, in paise
  if (nightlyMinor < 10000 || nightlyMinor > 100000000) return { skipped: "price out of range" };
  const cleaningUsd = num(source.cleaning_fee) || 0;
  const cleaningFeeMinor = clamp(Math.round(cleaningUsd * usdToInr) * 100, 0, 100000000);

  const picture = text(source.images?.picture_url);
  if (!/^https:\/\//.test(picture)) return { skipped: "no picture" };

  const address = addressOf(source);
  if (!address.city || !address.country) return { skipped: "no city or country" };

  const minNights = clamp(Math.round(num(source.minimum_nights) || 1), 1, 365);
  const maxNights = clamp(Math.round(num(source.maximum_nights) || 30), minNights, 365);
  const bathrooms = num(source.bathrooms);

  const doc = {
    title,
    description: text(source.description || source.summary, 2000),
    status: "published",
    propertyType: propertyTypeOf(source.property_type),
    roomType: roomTypeOf(source.room_type),
    image: { url: picture },
    images: [{ url: picture, alt: title, order: 0 }],
    location: [address.city, address.country].join(", "),
    country: address.country,
    address,
    geometry: { type: "Point", coordinates: [lng, lat] },
    capacity: {
      guests: clamp(Math.round(num(source.accommodates) || 2), 1, 16),
      bedrooms: clamp(Math.round(num(source.bedrooms) ?? 1), 0, 50),
      beds: clamp(Math.round(num(source.beds) ?? 1), 0, 50),
      bathrooms: bathrooms === null ? 1 : clamp(Math.round(bathrooms * 2) / 2, 0, 50),
    },
    amenities: amenitiesOf(source.amenities),
    houseRules: text(source.house_rules, 2000),
    minNights,
    maxNights,
    cancellationPolicy: cancellationOf(source.cancellation_policy),
    pricing: { nightlyMinor, cleaningFeeMinor, currency: "INR" },
    importedFrom: { source: "sample_airbnb", id },
    owner: ownerId,
    // bulkWrite skips the model's validate hook, so the search keys are set here.
    ...keysForListing({ address, country: address.country }),
  };
  return { doc };
}

module.exports = { unwrap, propertyTypeOf, roomTypeOf, cancellationOf, amenitiesOf, addressOf, mapListing };
