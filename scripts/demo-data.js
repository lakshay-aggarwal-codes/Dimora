// Data and pure builders for `npm run seed:demo` (P19-T02). No database, no
// clock of its own: everything that depends on "today" takes it as an argument,
// so tests can check the whole plan without MongoDB.
//
// The 29 sample places come from seed-data.js (title, text, price, cover photo,
// coordinates) and seed-classification.js (type, setting, pool). This file adds
// what a published listing needs to look complete: street, capacity, fees,
// rules, policy, five photos and a longer description.
const { data: sampleListings } = require("./seed-data.js");
const { classificationFor } = require("./seed-classification.js");
const { keysForListing } = require("../src/utils/searchKeys");
const { rupeesToMinor } = require("../src/utils/listingFields");

// Demo-only accounts. The addresses end in .invalid, which never resolves.
// Passwords are NOT stored here: each is generated at random when the account
// is created (or rotated) and printed once by the script.
const DEMO_ACCOUNTS = Object.freeze({
  host: {
    username: "dimora_demo_host",
    email: "demo-host@dimora.invalid",
    displayName: "Demo Host",
    bio: "Demo account. Hosts the sample places on this site. Not a real person.",
  },
  guest: {
    username: "dimora_demo_guest",
    email: "demo-guest@dimora.invalid",
    displayName: "Demo Guest",
    bio: "Demo account. Books the sample places on this site. Not a real person.",
  },
  guest2: {
    username: "dimora_demo_guest2",
    email: "demo-guest2@dimora.invalid",
    displayName: "Demo Guest Two",
    bio: "Second demo guest, so the host has more than one person to answer. Not a real person.",
  },
  admin: {
    username: "dimora_demo_admin",
    email: "demo-admin@dimora.invalid",
    displayName: "Demo Admin",
    bio: "Demo administrator account. Not a real person.",
  },
});

const CSP_IMAGE_HOST = "https://images.unsplash.com/";
const PHOTOS_PER_LISTING = 5; // the readiness checklist asks for 5
const WEEKEND_PREMIUM_VIBES = Object.freeze(["city", "beach"]); // +20% on Fri/Sat nights

// One row per sample title:
//   line1, guests, bedrooms, beds, baths, cleaning (rupees), min (nights),
//   instant (instant book), policy, amen (extra amenity codes), more (added to
//   the description). Street names are invented.
const EXTRAS = {
  "Cozy Beachfront Cottage": { line1: "12 Seaview Lane", guests: 4, bedrooms: 2, beds: 2, baths: 1, cleaning: 150, min: 2, instant: false, policy: "moderate", amen: "air_conditioning free_parking balcony smoke_alarm", more: "A short boardwalk leads from the porch to the sand. Mornings are quiet, evenings are for the deck, and the kitchen is set up for simple home cooking." },
  "Modern Loft in Downtown": { line1: "88 Mercer Row", guests: 2, bedrooms: 1, beds: 1, baths: 1, cleaning: 100, min: 2, instant: true, policy: "flexible", amen: "air_conditioning workspace tv washer smoke_alarm", more: "Floor-to-ceiling windows, a proper desk and fast Wi-Fi make this loft as good for a work trip as for a long weekend of walking the neighbourhood." },
  "Mountain Retreat": { line1: "5 Pinecrest Road", guests: 6, bedrooms: 3, beds: 4, baths: 2, cleaning: 200, min: 2, instant: false, policy: "moderate", amen: "heating free_parking tv first_aid_kit pets_allowed", more: "A wood stove warms the main room and trails start a few minutes from the door. Bring boots; the hosts leave a trail map and a first aid kit by the entrance." },
  "Historic Villa in Tuscany": { line1: "Via dei Cipressi 9", guests: 8, bedrooms: 4, beds: 5, baths: 3, cleaning: 400, min: 3, instant: false, policy: "strict", amen: "air_conditioning free_parking balcony washer smoke_alarm", more: "Terracotta floors, thick stone walls and a shaded terrace over the vines keep the house cool in summer. A long table seats the whole group for dinner." },
  "Secluded Treehouse Getaway": { line1: "Fernhill Trail, Lot 3", guests: 2, bedrooms: 1, beds: 1, baths: 1, cleaning: 80, min: 1, instant: true, policy: "flexible", amen: "heating balcony smoke_alarm", more: "Reached by a short wooden walkway, the treehouse has a heated bedroom, a small kitchen and a deck built around the trunk. Expect birdsong and very little else." },
  "Beachfront Paradise": { line1: "Blvd Kukulcan Km 12", guests: 6, bedrooms: 3, beds: 4, baths: 3, cleaning: 300, min: 2, instant: true, policy: "moderate", amen: "air_conditioning free_parking balcony gym tv", more: "The pool, the terrace and the beach are all on one level. Three bedrooms each have their own bathroom, so a group of friends or two families will not queue." },
  "Rustic Cabin by the Lake": { line1: "40 Shoreline Drive", guests: 5, bedrooms: 2, beds: 3, baths: 1, cleaning: 120, min: 2, instant: false, policy: "moderate", amen: "heating free_parking pets_allowed smoke_alarm", more: "A short path leads to the water, where a small dock and two kayaks are free to use. In the evening the fire pit and the porch swing are the main attractions." },
  "Luxury Penthouse with City Views": { line1: "1 Skyline Plaza, Floor 40", guests: 4, bedrooms: 2, beds: 2, baths: 2, cleaning: 350, min: 2, instant: true, policy: "strict", amen: "air_conditioning gym workspace tv washer", more: "Wrap-around glass shows the skyline by day and the lights by night. The building has a gym and a 24-hour front desk, and the kitchen is fully equipped." },
  "Ski-In/Ski-Out Chalet": { line1: "Route des Pistes 7", guests: 8, bedrooms: 4, beds: 6, baths: 3, cleaning: 400, min: 3, instant: false, policy: "strict", amen: "heating free_parking washer tv smoke_alarm", more: "Step out of the boot room and onto the piste. A drying cupboard, a stone fireplace and a large kitchen make long ski days easy to end well." },
  "Safari Lodge in the Serengeti": { line1: "Seronera Camp Road", guests: 4, bedrooms: 2, beds: 2, baths: 2, cleaning: 500, min: 3, instant: false, policy: "strict", amen: "first_aid_kit balcony smoke_alarm", more: "Each tent-style suite has a private veranda facing the plains. Game drives can be arranged with local guides, and the lodge keeps a first aid kit and radio." },
  "Historic Canal House": { line1: "Keizersgracht 210", guests: 4, bedrooms: 2, beds: 3, baths: 1, cleaning: 150, min: 2, instant: false, policy: "moderate", amen: "heating tv washer workspace smoke_alarm", more: "Steep stairs and tall windows are part of the charm. The living room looks over the canal, and cafes, markets and museums are a short walk away." },
  "Private Island Retreat": { line1: "Yadua Islet, South Bay", guests: 10, bedrooms: 5, beds: 7, baths: 4, cleaning: 800, min: 3, instant: false, policy: "strict", amen: "air_conditioning pool first_aid_kit balcony smoke_alarm", more: "The whole island is yours: five bedrooms, a pool, a private beach and a boat transfer from the mainland. Groceries and a cook can be arranged before arrival." },
  "Charming Cottage in the Cotswolds": { line1: "3 Honeysuckle Row", guests: 4, bedrooms: 2, beds: 2, baths: 1, cleaning: 120, min: 2, instant: true, policy: "moderate", amen: "heating free_parking pets_allowed tv smoke_alarm", more: "Stone walls, low beams and a cottage garden make this a classic English weekend. Footpaths to the next village start at the gate, and dogs are welcome." },
  "Historic Brownstone in Boston": { line1: "27 Beacon Hill Street", guests: 5, bedrooms: 3, beds: 3, baths: 2, cleaning: 200, min: 2, instant: true, policy: "flexible", amen: "air_conditioning heating workspace washer tv", more: "Three floors of original woodwork, a working fireplace and a quiet street lined with gas lamps. Parks, shops and the subway are within a few minutes' walk." },
  "Beachfront Bungalow in Bali": { line1: "Jalan Pantai Berawa 14", guests: 4, bedrooms: 2, beds: 2, baths: 2, cleaning: 100, min: 2, instant: true, policy: "flexible", amen: "air_conditioning free_parking balcony smoke_alarm", more: "Open-air living, a garden shower and a hammock a few steps from the surf. A housekeeper comes each morning and can arrange scooters and surf lessons." },
  "Mountain View Cabin in Banff": { line1: "21 Elk Ridge Trail", guests: 6, bedrooms: 3, beds: 4, baths: 2, cleaning: 180, min: 2, instant: false, policy: "moderate", amen: "heating free_parking tv washer first_aid_kit", more: "A hot tub on the deck faces the peaks, and the town shuttle stops at the end of the road. Skis, bikes and bear spray can be stored in the mudroom." },
  "Art Deco Apartment in Miami": { line1: "1420 Ocean Court, Apt 6", guests: 3, bedrooms: 1, beds: 2, baths: 1, cleaning: 100, min: 2, instant: true, policy: "moderate", amen: "air_conditioning workspace tv balcony smoke_alarm", more: "Pastel walls, terrazzo floors and a corner balcony put you in the middle of the historic district. The beach is a five-minute walk and cafes are downstairs." },
  "Tropical Villa in Phuket": { line1: "88/4 Kamala Hills Road", guests: 8, bedrooms: 4, beds: 5, baths: 4, cleaning: 350, min: 3, instant: false, policy: "moderate", amen: "air_conditioning free_parking gym balcony washer", more: "A private pool sits in the middle of the garden, with sea views from the upper terrace. Staff prepare breakfast on request and can book boat trips." },
  "Historic Castle in Scotland": { line1: "Glen Affric Estate", guests: 12, bedrooms: 6, beds: 8, baths: 4, cleaning: 900, min: 3, instant: false, policy: "strict", amen: "heating free_parking pets_allowed tv first_aid_kit", more: "A tower, a great hall and walled gardens for groups who want something unusual. Heating is by fireplaces and radiators; there are walks, fishing and stargazing on the estate." },
  "Desert Oasis in Dubai": { line1: "Al Qudra Road, Villa 18", guests: 8, bedrooms: 4, beds: 5, baths: 4, cleaning: 500, min: 2, instant: true, policy: "strict", amen: "air_conditioning free_parking gym balcony workspace", more: "A shaded courtyard pool, a majlis lounge and quiet desert views. Dune drives, camel rides and the city's malls are all within a short drive." },
  "Rustic Log Cabin in Montana": { line1: "Gallatin Creek Road 6", guests: 6, bedrooms: 3, beds: 4, baths: 2, cleaning: 140, min: 2, instant: false, policy: "flexible", amen: "heating free_parking pets_allowed first_aid_kit smoke_alarm", more: "Hand-hewn logs, a stone chimney and a porch facing open country. Fly fishing, hiking and the national park are close, and the nights are dark and full of stars." },
  "Beachfront Villa in Greece": { line1: "Agios Ioannis Beach Road", guests: 7, bedrooms: 3, beds: 4, baths: 3, cleaning: 300, min: 3, instant: false, policy: "moderate", amen: "air_conditioning free_parking balcony washer smoke_alarm", more: "Whitewashed walls, blue shutters and a terrace that ends at the sand. The village taverns are a short walk along the bay, and the ferry port is ten minutes by car." },
  "Eco-Friendly Treehouse Retreat": { line1: "Monteverde Cloud Forest Road", guests: 3, bedrooms: 1, beds: 2, baths: 1, cleaning: 60, min: 1, instant: true, policy: "flexible", amen: "heating balcony smoke_alarm", more: "Solar power, rainwater showers and a canopy-level deck. Guided night walks and bird tours start nearby, and the hosts explain how the house runs on very little." },
  "Historic Cottage in Charleston": { line1: "19 Tradd Street", guests: 4, bedrooms: 2, beds: 2, baths: 1, cleaning: 120, min: 2, instant: true, policy: "moderate", amen: "air_conditioning heating tv workspace smoke_alarm", more: "A pastel cottage with a walled courtyard on a cobbled street. Restaurants, the waterfront and the old market are all within walking distance." },
  "Modern Apartment in Tokyo": { line1: "2-14-8 Shibuya", guests: 3, bedrooms: 1, beds: 2, baths: 1, cleaning: 120, min: 2, instant: true, policy: "flexible", amen: "air_conditioning workspace washer tv smoke_alarm", more: "Compact, quiet and very well planned, with a rail station five minutes away. The hosts leave a guide to local restaurants, laundromats and late-night shops." },
  "Lakefront Cabin in New Hampshire": { line1: "63 Lake Winnipesaukee Road", guests: 6, bedrooms: 3, beds: 4, baths: 2, cleaning: 150, min: 2, instant: false, policy: "flexible", amen: "heating free_parking pets_allowed tv first_aid_kit", more: "A screened porch, a private dock and a canoe for the water. In autumn the hills turn red and gold, and in winter the woodstove does the work." },
  "Luxury Villa in the Maldives": { line1: "North Male Atoll, Villa 3", guests: 4, bedrooms: 2, beds: 2, baths: 2, cleaning: 900, min: 3, instant: false, policy: "strict", amen: "air_conditioning pool balcony first_aid_kit smoke_alarm", more: "An overwater villa with a glass floor panel, a private deck and steps into the lagoon. Boat transfers and snorkelling gear are included with the stay." },
  "Ski Chalet in Aspen": { line1: "310 Red Mountain Drive", guests: 8, bedrooms: 4, beds: 5, baths: 4, cleaning: 450, min: 3, instant: false, policy: "strict", amen: "heating free_parking tv washer smoke_alarm", more: "A heated driveway, a boot room and a hot tub under the pines. Lifts are a short drive away and the town's restaurants are close by." },
  "Secluded Beach House in Costa Rica": { line1: "Playa Pelada Camino 2", guests: 6, bedrooms: 3, beds: 4, baths: 3, cleaning: 200, min: 2, instant: true, policy: "moderate", amen: "air_conditioning free_parking balcony pets_allowed smoke_alarm", more: "A quiet beach house with a covered terrace and a short path to the sand. Surf lessons, turtle nesting tours and a small village market are nearby." },
};

const SHARED_RULES = "No parties or events. Quiet hours 22:00 to 07:00. No smoking indoors.";

const pad = (n) => String(n).padStart(2, "0");

/** Five distinct photos for each listing: its own cover first, then the nearest
 *  covers of other sample listings, same setting (vibe) before any other. They
 *  are borrowed pictures, not photos of that exact place. */
function photosFor(index, items = sampleListings) {
  const own = items[index];
  const vibeOf = (item) => (classificationFor(item.title) || {}).vibe;
  const ownVibe = vibeOf(own);
  const seen = new Set([own.image.url]);
  const ranked = items
    .map((item, j) => ({
      item,
      rank: (vibeOf(item) === ownVibe ? 0 : 1000) + ((j - index + items.length) % items.length),
    }))
    // Only hosts the Content-Security-Policy allows (one sample cover is on
    // plus.unsplash.com, which it does not: it stays that listing's own cover).
    .filter(({ item }) => item !== own && item.image.url.startsWith(CSP_IMAGE_HOST))
    .sort((a, b) => a.rank - b.rank);
  const urls = [own.image.url];
  for (const { item } of ranked) {
    if (urls.length >= PHOTOS_PER_LISTING) break;
    if (seen.has(item.image.url)) continue;
    seen.add(item.image.url);
    urls.push(item.image.url);
  }
  return urls.map((url, order) => ({
    url,
    publicId: "",
    alt: `${own.title}, photo ${order + 1}`,
    caption: "",
    order,
  }));
}

/** The demo listings in the v2 shape, ready for `Listing.bulkWrite`. */
function buildDemoListings(ownerId) {
  return sampleListings.map(({ price, ...item }, index) => {
    const extra = EXTRAS[item.title];
    if (!extra) throw new Error(`demo-data: no extras for "${item.title}"`);
    const cls = classificationFor(item.title);
    const address = { line1: extra.line1, city: item.location, country: item.country };
    const nightlyMinor = rupeesToMinor(price);
    const weekend = WEEKEND_PREMIUM_VIBES.includes(cls.vibe)
      ? Math.round((nightlyMinor * 1.2) / 100) * 100
      : undefined;
    const amenities = [...new Set([...(cls.amenities || []), ...extra.amen.split(" ")])];
    return {
      ...item,
      description: `${item.description} ${extra.more}`,
      status: "published",
      ...cls,
      address,
      image: item.image,
      images: photosFor(index),
      amenities,
      capacity: { guests: extra.guests, bedrooms: extra.bedrooms, beds: extra.beds, bathrooms: extra.baths },
      houseRules: `${SHARED_RULES} ${amenities.includes("pets_allowed") ? "Well-behaved pets are welcome." : "No pets."}`,
      checkInTime: "14:00",
      checkOutTime: "11:00",
      minNights: extra.min,
      maxNights: 30,
      instantBook: extra.instant,
      cancellationPolicy: extra.policy,
      pricing: {
        nightlyMinor,
        ...(weekend ? { weekendNightlyMinor: weekend } : {}),
        cleaningFeeMinor: rupeesToMinor(extra.cleaning),
        currency: "INR",
      },
      needsReview: false,
      // bulkWrite skips the model's validate hook, so the search keys are set here.
      ...keysForListing({ address, country: item.country }),
      owner: ownerId,
    };
  });
}

// ---------------------------------------------------------------------------
// Reservations: one scenario per interesting state, relative to "today".
//
//   guest / listing  who books which sample place (a different place each time)
//   inDays, nights   check-in as days from today (negative = in the past), length
//   guests           party size
//   bookedAgoHours   when the booking was made, before `now`
//   final            the state the run drives it to
//   respondAfterHours  (host moves) hours after booking that the host answered
//   review           { rating, comment } for completed stays still inside the review window
//
// Every move goes through the real services (reservations.create/transition,
// cancellations.cancelBooking, reviews.submit) with an injected clock, so the
// night ledger, price snapshot, refund and history are what the app writes.
const SCENARIOS = [
  { key: "g-pending", guest: "guest", listing: "Historic Canal House", inDays: 24, nights: 3, guests: 2, bookedAgoHours: 3, final: "pending" },
  { key: "g-confirmed-instant", guest: "guest", listing: "Modern Apartment in Tokyo", inDays: 30, nights: 4, guests: 2, bookedAgoHours: 48, final: "confirmed" },
  { key: "g-confirmed-accepted", guest: "guest", listing: "Cozy Beachfront Cottage", inDays: 45, nights: 5, guests: 3, bookedAgoHours: 20, respondAfterHours: 2, final: "confirmed" },
  { key: "g-cancelled-guest", guest: "guest", listing: "Beachfront Paradise", inDays: 3, nights: 3, guests: 4, bookedAgoHours: 144, final: "cancelled_by_guest", reason: "Plans changed, sorry." },
  { key: "g-completed-reviewable", guest: "guest", listing: "Luxury Penthouse with City Views", inDays: -25, nights: 3, guests: 2, bookedAgoHours: 24 * 40, final: "completed" },
  { key: "g-completed-old", guest: "guest", listing: "Historic Brownstone in Boston", inDays: -62, nights: 3, guests: 2, bookedAgoHours: 24 * 75, final: "completed" },
  { key: "g-completed-reviewed", guest: "guest", listing: "Modern Loft in Downtown", inDays: -12, nights: 3, guests: 2, bookedAgoHours: 24 * 30, final: "completed", review: { rating: 4, comment: "Bright, quiet and exactly as described. The desk and the Wi-Fi made working from here easy. The street can be busy at night, but the windows keep it out." } },
  { key: "h-pending", guest: "guest2", listing: "Mountain Retreat", inDays: 14, nights: 2, guests: 2, bookedAgoHours: 5, final: "pending" },
  { key: "h-declined", guest: "guest2", listing: "Rustic Cabin by the Lake", inDays: 28, nights: 3, guests: 4, bookedAgoHours: 5, respondAfterHours: 2, final: "declined", reason: "Sorry, those dates are held for a family visit." },
  { key: "h-expired", guest: "guest2", listing: "Mountain View Cabin in Banff", inDays: 50, nights: 4, guests: 3, bookedAgoHours: 72, final: "expired" },
  { key: "h-cancelled-host", guest: "guest2", listing: "Beachfront Bungalow in Bali", inDays: 35, nights: 4, guests: 2, bookedAgoHours: 96, final: "cancelled_by_host", reason: "A burst pipe means the bungalow is closed for repairs. Full refund." },
  { key: "h-completed-reviewed-1", guest: "guest2", listing: "Eco-Friendly Treehouse Retreat", inDays: -9, nights: 4, guests: 2, bookedAgoHours: 24 * 25, final: "completed", review: { rating: 5, comment: "Waking up in the canopy was the highlight of our trip. The hosts explained how the solar power and rainwater work, and the night walk was worth it." } },
  { key: "h-completed-reviewed-2", guest: "guest2", listing: "Art Deco Apartment in Miami", inDays: -18, nights: 3, guests: 2, bookedAgoHours: 24 * 30, final: "completed", review: { rating: 5, comment: "Great location, a five-minute walk to the beach. The balcony is small but perfect for breakfast. Check-in was smooth." } },
  { key: "h-completed-reviewed-3", guest: "guest2", listing: "Historic Cottage in Charleston", inDays: -30, nights: 3, guests: 3, bookedAgoHours: 24 * 45, final: "completed", review: { rating: 4, comment: "Lovely courtyard and a very walkable street. The cottage is small for three people, but the beds were comfortable and the host was quick to answer." } },
];

const MS_HOUR = 60 * 60 * 1000;

/** The scenarios with their dates filled in: check-in/out as YYYY-MM-DD from
 *  `today` (a date-only Date), plus the instants the booking and the host's
 *  answer happened at, from `now`. Pure. */
function planReservations(today, now) {
  const day = (offset) => {
    const d = new Date(today.getTime() + offset * 24 * MS_HOUR);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  return SCENARIOS.map((s) => {
    const bookedAt = new Date(now.getTime() - s.bookedAgoHours * MS_HOUR);
    return {
      ...s,
      idempotencyKey: `demo-${s.key}`,
      checkIn: day(s.inDays),
      checkOut: day(s.inDays + s.nights),
      bookedAt,
      respondedAt: s.respondAfterHours === undefined ? undefined : new Date(bookedAt.getTime() + s.respondAfterHours * MS_HOUR),
    };
  });
}

module.exports = {
  DEMO_ACCOUNTS,
  EXTRAS,
  PHOTOS_PER_LISTING,
  CSP_IMAGE_HOST,
  SCENARIOS,
  photosFor,
  buildDemoListings,
  planReservations,
};
