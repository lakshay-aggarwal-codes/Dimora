const mongoose = require("mongoose");
const passportLocalMongoose = require("passport-local-mongoose").default;
const { parseDateOnly } = require("../utils/dates");

const ROLES = ["member", "admin"];
const STATUSES = ["active", "suspended", "deleted"];

// Deliberately simple: one "@", no spaces, a dot in the domain. Strict address
// validation (Joi) is done by the signup form (`signupSchema`); this only keeps
// obvious garbage out of the unique index.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const userSchema = new mongoose.Schema(
  {
    // Stored trimmed and lower-case, so "Ann@Example.com" and "ann@example.com"
    // are the same address. The setter also applies to query filters.
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,
      unique: true,
      maxlength: [254, "Email is too long"],
      match: [EMAIL_PATTERN, "Enter a valid email address"],
    },

    // Shown instead of the username on public pages (P02-T03). Filled with the
    // username when empty (see the validate hook below).
    displayName: {
      type: String,
      trim: true,
      maxlength: [60, "Display name must be 60 characters or fewer"],
    },

    role: {
      type: String,
      enum: ROLES,
      default: "member",
      required: true,
    },

    // "suspended" accounts cannot log in (enforced by the login controller); "deleted" is
    // the anonymised state used by account deletion (P02-T04).
    status: {
      type: String,
      enum: STATUSES,
      default: "active",
      required: true,
    },

    // Same shape as Listing.image. Absent until the user uploads one (P02-T03).
    avatar: {
      url: { type: String },
      filename: { type: String },
    },

    bio: {
      type: String,
      trim: true,
      maxlength: [500, "Bio must be 500 characters or fewer"],
      default: "",
    },

    // How many confirmed bookings this person cancelled as a HOST (P09-T03).
    // Only ever incremented, by services/cancellations.js; shown on the
    // public profile when above zero.
    hostCancellationCount: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },

    // Which notification emails the member wants (P11-T05). Unset = the
    // group's default (config/notificationPrefs.js); in-app is always on.
    notificationEmail: {
      bookings: { type: Boolean },
      reminders: { type: Boolean },
      reviews: { type: Boolean },
    },

    // null = not verified. Set by the verification flow (P02-T05).
    emailVerifiedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Runs before validation so a user created with only a username still gets a
// display name. Not an arrow function: it needs `this`.
userSchema.pre("validate", function () {
  if (!this.displayName && this.username) {
    this.displayName = this.username;
  }
});

// Per-account brake on password guessing (P02-T02), on top of the per-IP rate
// limit. passport-local-mongoose slows repeated failures down (each failure
// makes the next attempt wait longer, up to MAX_INTERVAL_MS) and, after
// MAX_ATTEMPTS failures, refuses even the correct password until
// UNLOCK_INTERVAL_MS has passed since the last attempt. A correct password
// resets the counter.
const LOGIN_LIMITS = Object.freeze({
  MAX_ATTEMPTS: 10,
  UNLOCK_INTERVAL_MS: 15 * 60 * 1000,
  MAX_INTERVAL_MS: 5 * 60 * 1000,
});

userSchema.plugin(passportLocalMongoose, {
  limitAttempts: true,
  maxAttempts: LOGIN_LIMITS.MAX_ATTEMPTS,
  unlockInterval: LOGIN_LIMITS.UNLOCK_INTERVAL_MS,
  maxInterval: LOGIN_LIMITS.MAX_INTERVAL_MS,
});

// The plugin defaults `last` (time of the last attempt) to "now". Accounts
// created before this task have no such field, so "now" would be filled in each
// time they are loaded and their first login would look like a too-fast retry.
// A missing value means "no attempt yet".
userSchema.path("last").default(() => parseDateOnly("1970-01-01"));

const User = mongoose.model("User", userSchema);

module.exports = User;
module.exports.ROLES = ROLES;
module.exports.STATUSES = STATUSES;
module.exports.EMAIL_PATTERN = EMAIL_PATTERN;
module.exports.LOGIN_LIMITS = LOGIN_LIMITS;
