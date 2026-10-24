// A member's list of saved stays (P10-T01). Every member gets one default list
// ("Saved"), created the first time they save a stay. Items live in
// WishlistItem so a list can hold 100 stays without growing one document.
const mongoose = require("mongoose");
const { DEFAULT_NAME } = require("../config/wishlists");
const Schema = mongoose.Schema;

const wishlistSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, trim: true, maxlength: 60, default: DEFAULT_NAME },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// At most one default list per member, even when two requests race to make it.
wishlistSchema.index(
  { owner: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);
wishlistSchema.index({ owner: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Wishlist", wishlistSchema);
