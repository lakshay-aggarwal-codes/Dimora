const express = require("express");
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");

const app = express();
const PORT = 8080;

const MONGO_URL = "mongodb://127.0.0.1:27017/dimora";

main()
  .then(() => {
    console.log("Connected to DB");
  })
  .catch((err) => {
    console.log(err);
  });

async function main() {
  await mongoose.connect(MONGO_URL);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));

app.engine("ejs", ejsMate);
app.use(express.static(path.join(__dirname, '/public')));

app.get("/", (req, res) => {
  res.send("namaste");
});

// INDEX - Show all listings
app.get("/listings", async (req, res) => {
  const allListings = await Listing.find({});
  res.render("listings/index.ejs", { allListings });
});

// NEW - Show form
app.get("/listings/new", (req, res) => {
  res.render("listings/new.ejs");
});

// SHOW - Show one listing
app.get("/listings/:id", async (req, res) => {
  const { id } = req.params;

  const listing = await Listing.findById(id);

  res.render("listings/show.ejs", { listing });
});

// CREATE - Create listing
app.post("/listings", async (req, res) => {
  const newListing = new Listing(req.body.listing);

  await newListing.save();

  res.redirect("/listings");
});

// EDIT - Show edit form
app.get("/listings/:id/edit", async (req, res) => {
  const { id } = req.params;

  const listing = await Listing.findById(id);

  res.render("listings/edit.ejs", { listing });
});

// UPDATE - Update listing
app.put("/listings/:id", async (req, res) => {
  const { id } = req.params;

  await Listing.findByIdAndUpdate(id, req.body.listing);

  res.redirect(`/listings/${id}`);
});

// DELETE - Delete listing
app.delete("/listings/:id", async (req, res) => {
  const { id } = req.params;

  await Listing.findByIdAndDelete(id);

  res.redirect(`/listings`);
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
