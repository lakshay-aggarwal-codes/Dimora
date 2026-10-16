// Listing model v2 (P04-T01). Money is integer paise (ADR-002). Documents
// written before v2 are upgraded by scripts/migrations/003-listing-model-v2.js;
// until it has run they still load (every new field has a default or is
// optional) but show no price, because the old `price` field is now
// `legacyPrice`.
//
// Validators only run on fields that change, so an old listing with, say, a
// price under the floor can still be edited; the floor applies to new values.
const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const Review = require("./review");

const STATUSES = ["draft", "published", "unpublished", "suspended"];
const PROPERTY_TYPES = [
  "house",
  "apartment",
  "villa",
  "cabin",
  "cottage",
  "farm_stay",
  "hotel",
  "other",
];
const ROOM_TYPES = ["entire_place", "private_room", "shared_room"];
const CANCELLATION_POLICIES = ["flexible", "moderate", "strict"];

// Nightly price floor: INR 100 (10 000 paise). A stay below it is almost
// certainly a typo (1 instead of 1000). Ceiling: INR 10 lakh a night.
const MIN_NIGHTLY_MINOR = 10000;
const MAX_MINOR = 100000000;
const MAX_IMAGES = 10;
const MAX_GUESTS = 16;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const integer = {
  validator: (v) => v === null || v === undefined || Number.isInteger(v),
  message: "{PATH} must be a whole number",
};

const minorAmount = (min) => ({
  type: Number,
  min: [min, `{PATH} must be at least ${min} (minor units)`],
  max: [MAX_MINOR, "{PATH} is too large"],
  validate: integer,
});

// One gallery photo (P04-T03). `_id` identifies it in the photo routes.
// `publicId` is the Cloudinary id (empty for pictures that are not ours, such
// as seed data). `alt` is the text a screen reader reads, `caption` is shown
// under the photo in the viewer. The array order is the display order and
// `order` mirrors it (0 = the cover); src/services/images.js keeps both in step.
const imageSchema = new Schema({
  url: { type: String, required: true },
  publicId: { type: String },
  alt: { type: String, trim: true, maxlength: 200 },
  caption: { type: String, trim: true, maxlength: 200 },
  order: { type: Number, min: 0, validate: integer, default: 0 },
});

const nearbyItemSchema = new Schema(
  {
    name: { type: String },
    category: { type: String },
    distanceMeters: { type: Number, min: 0 },
  },
  { _id: false },
);

const count = (def, min, max) => ({
  type: Number,
  default: def,
  min,
  max,
  validate: integer,
});

const listingSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
    },

    description: {
      type: String,
    },

    // draft until the host publishes (P04-T05). Only published listings are
    // public. Listings created before v2 are migrated to published.
    status: {
      type: String,
      enum: STATUSES,
      default: "draft",
      required: true,
    },

    propertyType: { type: String, enum: PROPERTY_TYPES },
    roomType: { type: String, enum: ROOM_TYPES },

    // Mirror of the cover photo (images[0]), kept in step by the media service
    // (src/services/images.js) because older pages and the cards still read it.
    // images[] is the source of truth.
    image: {
      filename: {
        type: String,
      },
      url: {
        type: String,
      },
    },

    images: {
      type: [imageSchema],
      validate: {
        validator: (v) => v.length <= MAX_IMAGES,
        message: `A listing can have at most ${MAX_IMAGES} photos`,
      },
    },

    // Free text from the old form; kept because the pages still show it.
    location: {
      type: String,
    },

    country: {
      type: String,
    },

    // Structured address (the wizard fills it in, P04-T02). Derived from
    // location/country for old listings, which are flagged needsReview.
    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 100 },
      state: { type: String, trim: true, maxlength: 100 },
      country: { type: String, trim: true, maxlength: 100 },
      postalCode: { type: String, trim: true, maxlength: 20 },
    },

    // True while address (or price/coordinates) was guessed during migration
    // and the host has not confirmed it.
    needsReview: { type: Boolean, default: false },

    // Precise point: private (never sent to the browser as such, P06-T02).
    geometry: {
      type: {
        type: String,
        enum: ["Point"],
        required: true,
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },

    // Approximate point shown publicly; filled by P06-T02.
    publicGeometry: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined },
    },

    timezone: { type: String, default: "Asia/Kolkata" }, // ADR-008

    capacity: {
      guests: count(2, 1, MAX_GUESTS),
      bedrooms: count(1, 0, 50),
      beds: count(1, 0, 50),
      bathrooms: {
        type: Number,
        default: 1,
        min: 0,
        max: 50,
        validate: {
          validator: (v) => v === null || v === undefined || (v * 2) % 1 === 0,
          message: "{PATH} must be a whole or half number",
        },
      },
    },

    amenities: { type: [{ type: String, trim: true, maxlength: 60 }] },
    houseRules: { type: String, trim: true, maxlength: 2000 },

    checkInTime: {
      type: String,
      default: "14:00",
      match: [TIME_PATTERN, "Check-in time must look like 14:00"],
    },
    checkOutTime: {
      type: String,
      default: "11:00",
      match: [TIME_PATTERN, "Check-out time must look like 11:00"],
    },

    minNights: { type: Number, default: 1, min: 1, max: 365, validate: integer },
    maxNights: { type: Number, default: 30, min: 1, max: 365, validate: integer },

    instantBook: { type: Boolean, default: false },
    cancellationPolicy: {
      type: String,
      enum: CANCELLATION_POLICIES,
      default: "moderate",
    },

    pricing: {
      nightlyMinor: minorAmount(MIN_NIGHTLY_MINOR),
      weekendNightlyMinor: minorAmount(MIN_NIGHTLY_MINOR),
      cleaningFeeMinor: { ...minorAmount(0), default: 0 },
      currency: {
        type: String,
        default: "INR",
        match: [/^[A-Z]{3}$/, "Currency must be a 3-letter code such as INR"],
      },
    },

    // The old rupee price, kept as it was stored before migration 003.
    legacyPrice: { type: Number },

    // Denormalised from reviews; recomputed by the review code (P12-T02).
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0, validate: integer },

    // Nearby places cache (P15-T01).
    nearby: {
      fetchedAt: { type: Date },
      items: { type: [nearbyItemSchema] },
    },

    reviews: [
      {
        type: Schema.Types.ObjectId,
        ref: "Review",
      },
    ],
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    // Soft delete: the row stays, the pages stop showing it (P04-T05).
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

// A stay whose minimum is longer than its maximum can never be booked.
listingSchema.pre("validate", function () {
  if (
    Number.isFinite(this.minNights) &&
    Number.isFinite(this.maxNights) &&
    this.minNights > this.maxNights
  ) {
    this.invalidate(
      "minNights",
      "Minimum nights cannot be more than maximum nights",
      this.minNights,
    );
  }
});

// Index names are explicit and match scripts/migrations/003-listing-model-v2.js,
// which builds the same indexes on existing databases.
listingSchema.index(
  { status: 1, "address.city": 1 },
  { name: "status_1_address.city_1" },
);
listingSchema.index({ owner: 1, status: 1 }, { name: "owner_1_status_1" });
listingSchema.index(
  { title: "text", description: "text" },
  { name: "title_text_description_text" },
);
listingSchema.index(
  { "pricing.nightlyMinor": 1 },
  { name: "pricing.nightlyMinor_1" },
);
// 2dsphere(publicGeometry) comes with P06-T02.

listingSchema.post("findOneAndDelete", async (listing) => {
  if (listing) {
    await Review.deleteMany({ _id: { $in: listing.reviews } });
  }
});

const Listing = mongoose.model("Listing", listingSchema);

Listing.STATUSES = STATUSES;
Listing.MIN_NIGHTLY_MINOR = MIN_NIGHTLY_MINOR;
Listing.MAX_IMAGES = MAX_IMAGES;

module.exports = Listing;
