// One saved stay in one list (P10-T01). `owner` is repeated here so "which of
// these stays has this member saved?" is a single indexed query.
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const wishlistItemSchema = new Schema({
  wishlist: { type: Schema.Types.ObjectId, ref: "Wishlist", required: true },
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  listing: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
  createdAt: { type: Date, default: Date.now },
});

// A stay is in a list once: this index makes saving twice a no-op under races.
wishlistItemSchema.index({ wishlist: 1, listing: 1 }, { unique: true });
wishlistItemSchema.index({ owner: 1, createdAt: -1 });
wishlistItemSchema.index({ owner: 1, listing: 1 });

module.exports = mongoose.model("WishlistItem", wishlistItemSchema);
