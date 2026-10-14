const mongoose = require("mongoose");
const passportLocalMongoose = require("passport-local-mongoose").default;

const ROLES = ["member", "admin"];
const STATUSES = ["active", "suspended", "deleted"];

// Deliberately simple: one "@", no spaces, a dot in the domain. Strict address
// validation (Joi) belongs to the signup form (P02-T02); this only keeps
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

    // "suspended" accounts cannot log in (enforced in P02-T02); "deleted" is
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

userSchema.plugin(passportLocalMongoose);

const User = mongoose.model("User", userSchema);

module.exports = User;
module.exports.ROLES = ROLES;
module.exports.STATUSES = STATUSES;
module.exports.EMAIL_PATTERN = EMAIL_PATTERN;
