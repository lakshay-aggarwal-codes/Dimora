// The server the browser tests talk to (P17-T03). One process that
//   - replaces Cloudinary and Mapbox with local stand-ins,
//   - starts an in-memory MongoDB (or uses E2E_MONGODB_URI),
//   - seeds two members and two listings,
//   - serves the real app (src/app.js createApp) on E2E_PORT (default 3100),
//   - serves a small control interface on E2E_CONTROL_PORT (default 3101) that
//     lets a test move a booking's dates into the past and run the sweeper
//     ("time injected": no waiting, and nothing of this exists in the app).
// Never start it against a real database: it is for tests only.
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");

const ALIASES = {
  cloudinary: path.join(__dirname, "mocks", "cloudinary.js"),
  "@mapbox/mapbox-sdk/services/geocoding": path.join(__dirname, "mocks", "mapboxGeocoding.js"),
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return originalLoad.call(this, ALIASES[request] || request, ...rest);
};

const PORT = Number(process.env.E2E_PORT || 3100);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT || 3101);
const { USERS, LISTINGS } = require("./data");

async function startDatabase() {
  if (process.env.E2E_MONGODB_URI) return { uri: process.env.E2E_MONGODB_URI, stop: async () => {} };
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const server = await MongoMemoryServer.create();
  return { uri: `${server.getUri()}dimora_e2e`, stop: () => server.stop() };
}

async function seed() {
  const { createUser, createListing } = require("../tests/helpers/factories");
  const host = (await createUser({ username: USERS.host.username, email: USERS.host.email, password: USERS.password })).user;
  await createUser({ username: USERS.guest.username, email: USERS.guest.email, password: USERS.password });
  for (const spec of LISTINGS) {
    await createListing({
      owner: host,
      title: spec.title,
      description: spec.description,
      instantBook: spec.instantBook,
      location: "Panaji, Goa",
      country: "India",
      address: { line1: "12 Beach Road", city: "Panaji", state: "Goa", country: "India" },
      geometry: { type: "Point", coordinates: [73.8278, 15.4909] },
      price: spec.price,
      capacity: { guests: 4, bedrooms: 1, beds: 2, bathrooms: 1 },
      minNights: 1,
      maxNights: 14,
      cancellationPolicy: "flexible",
    });
  }
}

// Moves one booking's stay into the past, then lets the sweeper complete it.
async function completeStay(reservationId) {
  const Reservation = require("../src/models/reservation");
  const { createSweeper } = require("../src/services/sweeper");
  const { createLogger } = require("../src/config/logger");
  const day = 24 * 60 * 60 * 1000;
  const midnight = (offset) => {
    const d = new Date(Date.now() + offset * day);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  };
  const moved = await Reservation.updateOne(
    { _id: reservationId, status: "confirmed" },
    { $set: { checkIn: midnight(-8), checkOut: midnight(-5) } },
  );
  if (!moved.modifiedCount) return { ok: false, error: "no confirmed booking with that id" };
  const summary = await createSweeper({ logger: createLogger({ level: "silent" }) }).runOnce({ now: new Date() });
  return { ok: true, completed: summary.completed, errors: summary.errors };
}

function startControl() {
  return http
    .createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("Content-Type", "application/json");
      try {
        if (req.method === "POST" && url.pathname === "/complete-stay") {
          const result = await completeStay(url.searchParams.get("id"));
          res.statusCode = result.ok ? 200 : 404;
          return res.end(JSON.stringify(result));
        }
        res.statusCode = 404;
        return res.end(JSON.stringify({ ok: false }));
      } catch (err) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ ok: false, error: String(err && err.message) }));
      }
    })
    .listen(CONTROL_PORT, "127.0.0.1");
}

async function main() {
  const db = await startDatabase();
  const mongoose = require("mongoose");
  await mongoose.connect(db.uri);
  await seed();

  const session = require("express-session");
  const { createApp } = require("../src/app");
  const { createLogger } = require("../src/config/logger");
  const { testConfig } = require("../tests/helpers/config");
  require("../src/controllers/listing").initGeocoding();
  const app = createApp({
    config: testConfig({ port: PORT, appBaseUrl: `http://127.0.0.1:${PORT}`, mongodbUri: db.uri }),
    sessionStore: new session.MemoryStore(),
    logger: createLogger({ level: "silent" }),
  });
  const server = app.listen(PORT, "127.0.0.1", () => console.log(`e2e app on ${PORT}, control on ${CONTROL_PORT}`));
  const control = startControl();

  const stop = async () => {
    server.close();
    control.close();
    await mongoose.disconnect();
    await db.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("e2e server failed to start:", err);
  process.exit(1);
});
