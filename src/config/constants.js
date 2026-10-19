// Lists shared by the listing model, the listing wizard (P04-T02) and its
// views. `value` is what is stored; `label` is what a host sees.

const PROPERTY_TYPES = [
  { value: "house", label: "House" },
  { value: "apartment", label: "Apartment" },
  { value: "villa", label: "Villa" },
  { value: "cabin", label: "Cabin" },
  { value: "cottage", label: "Cottage" },
  { value: "farm_stay", label: "Farm stay" },
  { value: "hotel", label: "Hotel or guest house" },
  { value: "other", label: "Something else" },
];

const ROOM_TYPES = [
  { value: "entire_place", label: "The whole place" },
  { value: "private_room", label: "A private room" },
  { value: "shared_room", label: "A shared room" },
];

// The setting around a place (P05-T04). A host picks one; the category strip on
// /listings uses it for Beach, Mountains, Lake, Desert, Countryside and City.
const VIBES = [
  { value: "beach", label: "Beach" },
  { value: "mountain", label: "Mountains" },
  { value: "lake", label: "Lake" },
  { value: "desert", label: "Desert" },
  { value: "countryside", label: "Countryside" },
  { value: "city", label: "City" },
];

const CANCELLATION_POLICIES = [
  { value: "flexible", label: "Flexible" },
  { value: "moderate", label: "Moderate" },
  { value: "strict", label: "Strict" },
];

// `group` is only for showing amenities in sections on the listing page.
const AMENITY_GROUPS = ["Essentials", "Facilities", "Safety", "Good to know"];

const AMENITIES = [
  { value: "wifi", label: "Wi-Fi", group: "Essentials" },
  { value: "kitchen", label: "Kitchen", group: "Essentials" },
  { value: "washer", label: "Washing machine", group: "Essentials" },
  { value: "air_conditioning", label: "Air conditioning", group: "Essentials" },
  { value: "heating", label: "Heating", group: "Essentials" },
  { value: "tv", label: "TV", group: "Essentials" },
  { value: "workspace", label: "Dedicated workspace", group: "Essentials" },
  { value: "free_parking", label: "Free parking", group: "Facilities" },
  { value: "pool", label: "Pool", group: "Facilities" },
  { value: "gym", label: "Gym", group: "Facilities" },
  { value: "balcony", label: "Balcony or terrace", group: "Facilities" },
  { value: "smoke_alarm", label: "Smoke alarm", group: "Safety" },
  { value: "first_aid_kit", label: "First aid kit", group: "Safety" },
  { value: "pets_allowed", label: "Pets allowed", group: "Good to know" },
];

const values = (list) => list.map((item) => item.value);

module.exports = {
  PROPERTY_TYPES,
  ROOM_TYPES,
  VIBES,
  CANCELLATION_POLICIES,
  AMENITIES,
  AMENITY_GROUPS,
  PROPERTY_TYPE_VALUES: values(PROPERTY_TYPES),
  VIBE_VALUES: values(VIBES),
  ROOM_TYPE_VALUES: values(ROOM_TYPES),
  CANCELLATION_POLICY_VALUES: values(CANCELLATION_POLICIES),
  AMENITY_VALUES: values(AMENITIES),
};

// Host Readiness Checklist (P04-T05): what a listing needs before it can be
// published. Presence counts, not quality (see src/services/readiness.js).
const READINESS = Object.freeze({
  minPhotos: 5,
  minDescriptionChars: 200,
});
module.exports.READINESS = READINESS;
