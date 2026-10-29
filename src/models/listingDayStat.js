// Daily counters about one listing (P13-T03), one row per listing per day.
// The day is a date-only UTC-midnight Date for the calendar day in the app's
// time zone (utils/dates DEFAULT_TIMEZONE). Rows are only ever created and
// bumped with $inc by services/listingStats.js; nothing here is exact:
//   views          page opens, once per browser session per listing per day,
//                  bots and the host's own visits left out
//   saves          stays saved that day (an un-save does not subtract: the
//                  lifetime total in ListingStat.saves is the net figure)
//   checkoutStarts checkout page opens, same once-per-session-per-day rule
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const counter = { type: Number, default: 0, min: 0 };

const listingDayStatSchema = new Schema({
  listing: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
  day: { type: Date, required: true },
  views: counter,
  saves: counter,
  checkoutStarts: counter,
});

listingDayStatSchema.index({ listing: 1, day: 1 }, { unique: true });

module.exports = mongoose.model("ListingDayStat", listingDayStatSchema);
