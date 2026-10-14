const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const reviewSchema = new Schema(
  {
    comment: String,
    rating: {
      type: Number,
      min: 1,
      max: 5,
    },
    // Legacy misspelt field; its default was evaluated once at load time, so
    // every review got the same value. Superseded by `createdAt` (timestamps);
    // the P12-T01 migration drops it.
    crestedAt: {
      type: Date,
      default: Date.now,
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Review", reviewSchema);
