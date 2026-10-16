// P04-T04 through the real routes: editing a published listing section by
// section, and the location confirmation. Cloudinary and Mapbox are mocked.
// Needs a MongoDB (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const { geocoding, resetExternalMocks } = require("../helpers/mocks");
const Listing = require("../../src/models/listing");

const LOCATION = {
  line1: "12 Beach Road",
  city: "Goa",
  state: "Goa",
  country: "India",
  postalCode: "403001",
};
const NEW_PLACE = { type: "Point", coordinates: [73.8, 15.5] };

async function ownerWithListing(overrides = {}) {
  const { user, password } = await createUser();
  const agent = await login(createAgent(), { username: user.username, password });
  const listing = await createListing({
    owner: user._id,
    title: "Original title",
    address: { ...LOCATION },
    needsReview: true,
    ...overrides,
  });
  return { agent, user, listing };
}

const save = (agent, listing, key, body) =>
  agent.put(`/listings/${listing._id}/sections/${key}`).type("form").send(body);
const reload = (listing) => Listing.findById(listing._id);

beforeEach(() => geocoding.forwardGeocode.mockClear());
afterEach(resetExternalMocks);

describeDb("listing sections and location confirmation", () => {
  useTestDb();

  describe("the edit page", () => {
    test("shows a form for every section and the photo manager", async () => {
      const { agent, listing } = await ownerWithListing();
      const res = await agent.get(`/listings/${listing._id}/edit`);
      expect(res.status).toBe(200);
      for (const key of ["basics", "location", "details", "pricing"]) {
        expect(res.text).toContain(`/listings/${listing._id}/sections/${key}?_method=PUT`);
      }
      expect(res.text).toContain("Original title");
      expect(res.text).toContain("12 Beach Road");
      expect(res.text).toContain('id="photos"');
    });

    test("a listing whose address was guessed asks the host to confirm it", async () => {
      const { agent, listing } = await ownerWithListing({ needsReview: true });
      const res = await agent.get(`/listings/${listing._id}/edit`);
      expect(res.text).toContain("We guessed this listing's address");
    });

    test("a draft is sent to the wizard instead", async () => {
      const { agent, listing } = await ownerWithListing({ status: "draft" });
      const res = await agent.get(`/listings/${listing._id}/edit`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/host/listings/${listing._id}`);
    });

    test("someone else gets 403", async () => {
      const { listing } = await ownerWithListing();
      const { user, password } = await createUser();
      const stranger = await login(createAgent(), { username: user.username, password });
      expect((await stranger.get(`/listings/${listing._id}/edit`)).status).toBe(403);
      expect((await save(stranger, listing, "basics", {})).status).toBe(403);
    });
  });

  describe("basics, details and pricing", () => {
    test("each section saves on its own and leaves the others alone", async () => {
      const { agent, listing } = await ownerWithListing();
      const res = await save(agent, listing, "basics", {
        title: "A brand new title",
        description: "A description that is long enough to be valid.",
        propertyType: "villa",
        roomType: "private_room",
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${listing._id}/edit#basics`);
      const stored = await reload(listing);
      expect(stored.title).toBe("A brand new title");
      expect(stored.propertyType).toBe("villa");
      expect(stored.pricing.nightlyMinor).toBe(listing.pricing.nightlyMinor);
      expect(stored.address.line1).toBe("12 Beach Road");
      expect(stored.status).toBe("published");
    });

    test("details are saved with the amenities as ticked", async () => {
      const { agent, listing } = await ownerWithListing();
      await save(agent, listing, "details", {
        guests: "6",
        bedrooms: "3",
        beds: "4",
        bathrooms: "2.5",
        amenities: ["wifi", "pool"],
      });
      const stored = await reload(listing);
      expect(stored.capacity.guests).toBe(6);
      expect(stored.capacity.bathrooms).toBe(2.5);
      expect([...stored.amenities]).toEqual(["wifi", "pool"]);
    });

    test("pricing is stored in paise; below INR 100 is refused and nothing changes", async () => {
      const { agent, listing } = await ownerWithListing();
      const body = {
        price: "3000",
        cleaningFee: "",
        minNights: "2",
        maxNights: "14",
        checkInTime: "15:00",
        checkOutTime: "10:00",
        cancellationPolicy: "strict",
      };
      const low = await save(agent, listing, "pricing", { ...body, price: "99" });
      expect(low.status).toBe(400);
      expect(low.text).toMatch(/Nightly price must be at least ₹100/);
      expect((await reload(listing)).pricing.nightlyMinor).toBe(listing.pricing.nightlyMinor);

      const ok = await save(agent, listing, "pricing", body);
      expect(ok.status).toBe(302);
      const stored = await reload(listing);
      expect(stored.pricing.nightlyMinor).toBe(300000);
      expect(stored.minNights).toBe(2);
      expect(stored.cancellationPolicy).toBe("strict");
    });

    test("a refused section shows its own errors and the typed values; other sections show stored data", async () => {
      const { agent, listing } = await ownerWithListing();
      const res = await save(agent, listing, "basics", {
        title: "Hi",
        description: "short",
        propertyType: "villa",
        roomType: "private_room",
      });
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/Title must be at least 5 characters/);
      expect(res.text).toContain("Please fix the highlighted fields");
      expect(res.text).toContain("12 Beach Road");
      expect((await reload(listing)).title).toBe("Original title");
    });

    test("a field that is not part of the section cannot be smuggled in", async () => {
      const { agent, listing } = await ownerWithListing();
      const res = await save(agent, listing, "basics", {
        title: "A brand new title",
        description: "A description that is long enough to be valid.",
        propertyType: "villa",
        roomType: "private_room",
        status: "suspended",
        owner: "someone",
      });
      expect(res.status).toBe(400);
      expect((await reload(listing)).status).toBe("published");
    });

    test("an unknown section is a 404", async () => {
      const { agent, listing } = await ownerWithListing();
      expect((await save(agent, listing, "owner", {})).status).toBe(404);
      expect((await save(agent, listing, "photos", {})).status).toBe(404);
    });

    test("a published listing keeps its photos, status and reviews when a section is saved", async () => {
      const { agent, listing } = await ownerWithListing();
      await save(agent, listing, "details", {
        guests: "2",
        bedrooms: "1",
        beds: "1",
        bathrooms: "1",
      });
      const stored = await reload(listing);
      expect(stored.image.url).toBe(listing.image.url);
      expect(stored.status).toBe("published");
    });
  });

  describe("location confirmation", () => {
    const changed = { ...LOCATION, line1: "14 Hill Road" };

    test("a changed address is looked up and shown for confirmation; nothing is saved yet", async () => {
      const { agent, listing } = await ownerWithListing();
      geocoding.__setFeatures([{ place_name: "Panaji, Goa, India", geometry: NEW_PLACE }]);
      const res = await save(agent, listing, "location", changed);
      expect(res.status).toBe(200);
      expect(res.text).toContain("Is this the right place?");
      expect(res.text).toContain("Panaji, Goa, India");
      expect(res.text).toContain("14 Hill Road");
      expect(res.text).toMatch(/name="confirmed"[^>]*required/);
      expect(res.text).not.toContain('name="geometry"');
      const stored = await reload(listing);
      expect(stored.address.line1).toBe("12 Beach Road");
      expect(stored.geometry.coordinates).toEqual(listing.geometry.coordinates);
    });

    test("confirming saves the address and the point that was looked up (one look-up in all)", async () => {
      const { agent, listing } = await ownerWithListing();
      geocoding.__setFeatures([{ place_name: "Panaji, Goa, India", geometry: NEW_PLACE }]);
      await save(agent, listing, "location", changed);
      geocoding.__setFeatures([{ geometry: { type: "Point", coordinates: [1, 1] } }]);
      const res = await save(agent, listing, "location", { ...changed, confirmed: "on" });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${listing._id}/edit#location`);
      const stored = await reload(listing);
      expect(stored.address.line1).toBe("14 Hill Road");
      expect(stored.geometry.coordinates).toEqual([73.8, 15.5]);
      expect(stored.needsReview).toBe(false);
      expect(geocoding.forwardGeocode).toHaveBeenCalledTimes(1);
    });

    test("without the box ticked nothing is saved and the confirmation is shown again", async () => {
      const { agent, listing } = await ownerWithListing();
      await save(agent, listing, "location", changed);
      const res = await save(agent, listing, "location", changed);
      expect(res.status).toBe(200);
      expect(res.text).toContain("Is this the right place?");
      expect((await reload(listing)).address.line1).toBe("12 Beach Road");
    });

    test("a confirmation for a different address than the one looked up is not accepted (the point cannot be swapped)", async () => {
      const { agent, listing } = await ownerWithListing();
      await save(agent, listing, "location", changed);
      const res = await save(agent, listing, "location", {
        ...changed,
        line1: "99 Other Road",
        confirmed: "on",
      });
      expect(res.status).toBe(200);
      expect(res.text).toContain("Is this the right place?");
      expect((await reload(listing)).address.line1).toBe("12 Beach Road");
    });

    test("a confirmation works once; sent again it looks the address up again", async () => {
      const { agent, listing } = await ownerWithListing();
      await save(agent, listing, "location", changed);
      await save(agent, listing, "location", { ...changed, confirmed: "on" });
      geocoding.forwardGeocode.mockClear();
      const another = { ...changed, line1: "16 Hill Road" };
      const res = await save(agent, listing, "location", { ...another, confirmed: "on" });
      expect(res.status).toBe(200);
      expect(geocoding.forwardGeocode).toHaveBeenCalledTimes(1);
    });

    test("another member cannot confirm (or start) a change to this listing's address", async () => {
      const { agent, listing } = await ownerWithListing();
      await save(agent, listing, "location", changed);
      const { user, password } = await createUser();
      const other = await login(createAgent(), { username: user.username, password });
      const res = await save(other, listing, "location", { ...changed, confirmed: "on" });
      expect(res.status).toBe(403);
    });

    test("an address Mapbox cannot find is a message on the edit page and nothing changes", async () => {
      const { agent, listing } = await ownerWithListing();
      geocoding.__noResults();
      const res = await save(agent, listing, "location", changed);
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/couldn&#39;t find that location/i);
      expect(res.text).toContain("14 Hill Road");
      expect((await reload(listing)).address.line1).toBe("12 Beach Road");
    });

    test("a Mapbox outage says to try again and does not leak the error", async () => {
      const { agent, listing } = await ownerWithListing();
      geocoding.__failWith(new Error("ECONNRESET"));
      const res = await save(agent, listing, "location", changed);
      expect(res.status).toBe(503);
      expect(res.text).toMatch(/temporarily unavailable/i);
      expect(res.text).not.toMatch(/ECONNRESET/);
    });

    test("saving the same address again needs no look-up and no confirmation", async () => {
      const { agent, listing } = await ownerWithListing();
      const res = await save(agent, listing, "location", { ...LOCATION });
      // The factory listing has coordinates, so nothing about the address changed.
      expect(res.status).toBe(302);
      expect(geocoding.forwardGeocode).not.toHaveBeenCalled();
    });

    test("a listing with no stored point is looked up even for the same address", async () => {
      const { agent, listing } = await ownerWithListing();
      await Listing.updateOne({ _id: listing._id }, { $set: { "geometry.coordinates": [] } });
      const res = await save(agent, listing, "location", { ...LOCATION });
      expect(res.status).toBe(200);
      expect(geocoding.forwardGeocode).toHaveBeenCalledTimes(1);
    });

    test("the street address is not put in the public location text", async () => {
      const { agent, listing } = await ownerWithListing();
      await save(agent, listing, "location", changed);
      await save(agent, listing, "location", { ...changed, confirmed: "on" });
      const stored = await reload(listing);
      expect(stored.location).toBe("Goa, Goa");
      expect(stored.location).not.toMatch(/Hill Road/);
    });
  });
});
