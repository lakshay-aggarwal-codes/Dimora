const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const listingSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  //   image: {
  //     type: String,
  // default:
  //   "https://www.magnific.com/free-vector/hand-drawn-flat-design-digital-detox-illustration_23997843.htm#fromView=keyword&page=1&position=1&uuid=06442459-8f98-456a-99c7-1c5177af84f1&track=ais_hybrid&query=No+device+found",
  // set: (v) =>
  //   v === ""
  // ? "https://www.magnific.com/free-vector/hand-drawn-flat-design-digital-detox-illustration_23997843.htm#fromView=keyword&page=1&position=1&uuid=06442459-8f98-456a-99c7-1c5177af84f1&track=ais_hybrid&query=No+device+found"
  //     : v,
  //   },

  image: {
    filename: String,
    url: String,
  },
  price: {
    type: Number,
  },
  location: {
    type: String,
  },
  country: {
    type: String,
  },
});

const Listing = mongoose.model("Listing", listingSchema);
module.exports = Listing;
