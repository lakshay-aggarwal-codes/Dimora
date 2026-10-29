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

// What each cancellation policy says on a booking (P09-T01, P09-T03). Plain
// wording shown to guests at checkout and on the booking page. The refund rules
// that enforce it are DATA in src/config/cancellation.js: change a sentence and
// its rule together (tests/unit/refunds.test.js checks the numbers).
const CANCELLATION_COMMON =
  " Once the stay has started, nothing is refunded. A request the host has not answered yet can always be cancelled for free, and if the host cancels, you get everything back.";
const CANCELLATION_TERMS = Object.freeze({
  flexible:
    "Free cancellation until 24 hours before check-in. After that, the first night is not refunded." +
    CANCELLATION_COMMON,
  moderate:
    "Free cancellation until 5 days before check-in. After that, the first night and half of the remaining nights are not refunded." +
    CANCELLATION_COMMON,
  strict:
    "Free cancellation within 48 hours of booking if check-in is at least 14 days away. After that, half of the stay is refunded until 7 days before check-in, and nothing after." +
    CANCELLATION_COMMON,
});

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

// Accessibility features (P15-T05). The HOST declares them; Dimora does not
// check them, and the pages say so (ACCESSIBILITY_NOTICE). Kept apart from
// AMENITIES so a feature is never shown as a verified fact.
const ACCESSIBILITY_FEATURES = [
  { value: "step_free_entrance", label: "Step-free entrance" },
  { value: "step_free_bathroom", label: "Step-free bathroom" },
  { value: "elevator", label: "Elevator" },
  { value: "wide_doorway", label: "Wide doorways" },
  { value: "grab_rails", label: "Grab rails in the bathroom" },
  { value: "accessible_parking", label: "Accessible parking" },
];

const ACCESSIBILITY_NOTICE =
  "Declared by the host. Dimora has not checked these details.";

const values = (list) => list.map((item) => item.value);

module.exports = {
  PROPERTY_TYPES,
  ROOM_TYPES,
  VIBES,
  CANCELLATION_POLICIES,
  CANCELLATION_TERMS,
  AMENITIES,
  AMENITY_GROUPS,
  ACCESSIBILITY_FEATURES,
  ACCESSIBILITY_NOTICE,
  ACCESSIBILITY_VALUES: values(ACCESSIBILITY_FEATURES),
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
