// Counters about one listing, kept apart from the listing so counting never
// rewrites (or races with) a host's edit. `saves` = wishlist entries holding
// the listing (P10-T01). Host stats (P13-T03) read it.
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const listingStatSchema = new Schema({
  listing: {
    type: Schema.Types.ObjectId,
    ref: "Listing",
    required: true,
    unique: true,
  },
  saves: { type: Number, default: 0, min: 0 },
  // How often the stay was shown on, and opened from, a results page ordered by
  // Best match, per ordering (P15-T06; src/services/rankingStats.js).
  ranking: Object.fromEntries(
    ["default", "work", "family", "weekend"].map((variant) => [
      variant,
      { shown: { type: Number, default: 0, min: 0 }, clicked: { type: Number, default: 0, min: 0 } },
    ]),
  ),
});

module.exports = mongoose.model("ListingStat", listingStatSchema);
