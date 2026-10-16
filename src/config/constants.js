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

const CANCELLATION_POLICIES = [
  { value: "flexible", label: "Flexible" },
  { value: "moderate", label: "Moderate" },
  { value: "strict", label: "Strict" },
];

const AMENITIES = [
  { value: "wifi", label: "Wi-Fi" },
  { value: "kitchen", label: "Kitchen" },
  { value: "washer", label: "Washing machine" },
  { value: "air_conditioning", label: "Air conditioning" },
  { value: "heating", label: "Heating" },
  { value: "free_parking", label: "Free parking" },
  { value: "tv", label: "TV" },
  { value: "workspace", label: "Dedicated workspace" },
  { value: "pool", label: "Pool" },
  { value: "gym", label: "Gym" },
  { value: "balcony", label: "Balcony or terrace" },
  { value: "pets_allowed", label: "Pets allowed" },
  { value: "smoke_alarm", label: "Smoke alarm" },
  { value: "first_aid_kit", label: "First aid kit" },
];

const values = (list) => list.map((item) => item.value);

module.exports = {
  PROPERTY_TYPES,
  ROOM_TYPES,
  CANCELLATION_POLICIES,
  AMENITIES,
  PROPERTY_TYPE_VALUES: values(PROPERTY_TYPES),
  ROOM_TYPE_VALUES: values(ROOM_TYPES),
  CANCELLATION_POLICY_VALUES: values(CANCELLATION_POLICIES),
  AMENITY_VALUES: values(AMENITIES),
};
