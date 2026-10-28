// A search a member saved with a name (P10-T02). `query` is the canonical
// query string of /listings (built by the server from the validated search
// state, never copied from the browser), without the page number.
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const savedSearchSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, trim: true, required: true, maxlength: 60 },
    query: { type: String, required: true, maxlength: 1000 },
  },
  { timestamps: true },
);

savedSearchSchema.index({ owner: 1, name: 1 }, { unique: true });
savedSearchSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model("SavedSearch", savedSearchSchema);
