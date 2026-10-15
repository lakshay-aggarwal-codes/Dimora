// Builders for test data. build* return plain objects/unsaved documents (no
// database needed); create* save to the connected test database.
const User = require("../../src/models/user");
const Listing = require("../../src/models/listing");
const Review = require("../../src/models/review");

let seq = 0;
const next = () => (seq += 1);

function buildUserData(overrides = {}) {
  const n = next();
  return {
    username: `user${n}`,
    email: `user${n}@example.com`,
    password: "correct-horse-battery",
    ...overrides,
  };
}

// `price` (rupees) is shorthand for pricing.nightlyMinor; `price: undefined`
// builds a listing with no price. Pass `pricing` to set the v2 object directly.
function buildListingData(overrides = {}) {
  const n = next();
  const { price = 2500, ...rest } = overrides;
  const hasPrice = !("price" in overrides) || overrides.price !== undefined;
  return {
    title: `Test listing ${n}`,
    description: "A comfortable place to stay.",
    image: {
      url: `https://res.cloudinary.test/dimora_DEV/seed${n}.jpg`,
      filename: `dimora_DEV/seed${n}`,
    },
    status: "published",
    ...(hasPrice && price !== null
      ? { pricing: { nightlyMinor: Math.round(price * 100), currency: "INR" } }
      : {}),
    location: "New Delhi",
    country: "India",
    address: { city: "New Delhi", country: "India" },
    geometry: { type: "Point", coordinates: [77.209, 28.6139] },
    ...rest,
  };
}

/** Registers a user via passport-local-mongoose. Returns { user, password }. */
async function createUser(overrides = {}) {
  const { username, email, password } = buildUserData(overrides);
  const user = await User.register(new User({ username, email }), password);
  return { user, password };
}

async function createListing({ owner, ...overrides } = {}) {
  const ownerId = owner ? owner._id || owner : (await createUser()).user._id;
  return Listing.create(buildListingData({ owner: ownerId, ...overrides }));
}

async function createReview({ listing, author, ...overrides } = {}) {
  const review = await Review.create({
    comment: "Lovely stay.",
    rating: 5,
    author: author ? author._id || author : undefined,
    ...overrides,
  });
  if (listing) {
    listing.reviews.push(review);
    await listing.save();
  }
  return review;
}

module.exports = {
  buildUserData,
  buildListingData,
  createUser,
  createListing,
  createReview,
};
