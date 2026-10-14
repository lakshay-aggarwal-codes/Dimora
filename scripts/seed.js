const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const initData = require("./data.js");

const MONGO_URL = "mongodb://127.0.0.1:27017/dimora";

async function main() {
  try {
    await mongoose.connect(MONGO_URL);
    console.log("Connected to DB");

    await initDB();
    console.log("Data was initialized successfully");
    await mongoose.connection.close();
  } catch (err) {
    console.log("ERROR:", err);
  }
}

async function initDB() {
  await Listing.deleteMany({});
  initData.data = initData.data.map((obj) => ({
    ...obj,
    owner: "6aaa6f18c29707e1bde55246",
  }));
  await Listing.insertMany(initData.data);
  console.log("New data inserted");
}

main();
