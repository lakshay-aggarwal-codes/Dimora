// P01-T05: create / edit / delete a listing through the real routes, with
// Cloudinary and Mapbox mocked. Needs a MongoDB (see tests/helpers/db.js).
const mongoose = require("mongoose");
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const { uploader, geocoding, resetExternalMocks } = require("../helpers/mocks");
const Listing = require("../../src/models/listing");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const IMAGE_FIELD = "listing[image][url]";

const fields = (overrides = {}) => ({
  "listing[title]": "Seaside Cottage",
  "listing[description]": "Steps from the beach.",
  "listing[location]": "Goa",
  "listing[country]": "India",
  "listing[price]": "2500",
  ...overrides,
});

function multipart(req, values, file) {
  for (const [name, value] of Object.entries(values)) req.field(name, value);
  if (file) {
    req.attach(IMAGE_FIELD, file.buffer || PNG, {
      filename: file.filename || "photo.png",
      contentType: file.contentType || "image/png",
    });
  }
  return req;
}

const postListing = (agent, values, file) =>
  multipart(agent.post("/listings"), values, file);
const putListing = (agent, id, values, file) =>
  multipart(agent.put(`/listings/${id}`), values, file);

async function loggedInAgent() {
  const { user, password } = await createUser();
  const agent = await login(createAgent(), {
    username: user.username,
    password,
  });
  return { agent, user };
}

afterEach(resetExternalMocks);

describeDb("listing create / edit / delete", () => {
  useTestDb();

  describe("create", () => {
    test("with an image: 302, stored geometry, uploaded image, owner set", async () => {
      const { agent, user } = await loggedInAgent();
      const res = await postListing(agent, fields(), {});
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/listings");

      const listing = await Listing.findOne({ title: "Seaside Cottage" });
      expect(listing).not.toBeNull();
      expect(String(listing.owner)).toBe(String(user._id));
      expect(listing.pricing.nightlyMinor).toBe(250000);
      expect(listing.status).toBe("published");
      expect(listing.images).toHaveLength(1);
      expect(listing.images[0].url).toBe(listing.image.url);
      expect(listing.address.city).toBe(listing.location);
      expect(listing.needsReview).toBe(true);
      expect(listing.geometry.type).toBe("Point");
      expect([...listing.geometry.coordinates]).toEqual([77.209, 28.6139]);
      expect(listing.image.url).toMatch(
        /^https:\/\/res\.cloudinary\.test\/dimora_DEV\//,
      );
      expect(listing.image.filename).toMatch(/^dimora_DEV\/image\d+$/);
      expect(geocoding.forwardGeocode).toHaveBeenCalledWith({
        query: "Goa, India",
        limit: 1,
      });
      expect(uploader.upload_stream).toHaveBeenCalledTimes(1);
    });

    test("without an image: 400, nothing saved, nothing uploaded or geocoded", async () => {
      const { agent } = await loggedInAgent();
      const res = await postListing(agent, fields());
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/choose an image/i);
      expect(await Listing.countDocuments()).toBe(0);
      expect(uploader.upload_stream).not.toHaveBeenCalled();
      expect(geocoding.forwardGeocode).not.toHaveBeenCalled();
    });

    test("with invalid fields: 400 and no upload", async () => {
      const { agent } = await loggedInAgent();
      const res = await postListing(
        agent,
        fields({ "listing[title]": "  " }),
        {},
      );
      expect(res.status).toBe(400);
      expect(await Listing.countDocuments()).toBe(0);
      expect(uploader.upload_stream).not.toHaveBeenCalled();
    });

    test("a text value for the image field is rejected (the image comes only from the upload)", async () => {
      const { agent } = await loggedInAgent();
      const res = await postListing(
        agent,
        fields({ "listing[image][url]": "http://evil.example/x.png" }),
        {},
      );
      expect(res.status).toBe(400);
      expect(await Listing.countDocuments()).toBe(0);
    });

    test("a location Mapbox cannot find: friendly message back on the form, nothing saved or uploaded", async () => {
      const { agent } = await loggedInAgent();
      geocoding.__noResults();
      const res = await postListing(
        agent,
        fields({ "listing[location]": "Qwxz" }),
        {},
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/listings/new");
      const form = await agent.get("/listings/new");
      expect(form.text).toMatch(/couldn&#39;t find that location/i);
      expect(await Listing.countDocuments()).toBe(0);
      expect(uploader.upload_stream).not.toHaveBeenCalled();
    });

    test("a Mapbox outage: 'try again' message back on the form, nothing saved", async () => {
      const { agent } = await loggedInAgent();
      geocoding.__failWith(new Error("ECONNRESET"));
      const res = await postListing(agent, fields(), {});
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/listings/new");
      const form = await agent.get("/listings/new");
      expect(form.text).toMatch(/temporarily unavailable/i);
      expect(form.text).not.toMatch(/ECONNRESET/);
      expect(await Listing.countDocuments()).toBe(0);
    });

    test("a file that is not PNG/JPEG is rejected before anything else happens", async () => {
      const { agent } = await loggedInAgent();
      const res = await postListing(agent, fields(), {
        buffer: Buffer.from("not an image"),
        filename: "notes.txt",
        contentType: "text/plain",
      });
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/PNG, JPEG or WebP/);
      expect(await Listing.countDocuments()).toBe(0);
      expect(uploader.upload_stream).not.toHaveBeenCalled();
    });

    test("anonymous visitors are sent to /login and nothing is uploaded", async () => {
      const res = await postListing(createAgent(), fields(), {});
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login");
      expect(uploader.upload_stream).not.toHaveBeenCalled();
    });

    test("if saving fails after the upload, the uploaded image is deleted again", async () => {
      const { agent } = await loggedInAgent();
      jest
        .spyOn(Listing.prototype, "save")
        .mockRejectedValueOnce(new Error("db down"));
      const res = await postListing(agent, fields(), {});
      expect(res.status).toBe(500);
      expect(uploader.destroy).toHaveBeenCalledTimes(1);
      expect(uploader.destroy.mock.calls[0][0]).toMatch(
        /^dimora_DEV\/image\d+$/,
      );
    });
  });

  describe("edit", () => {
    async function ownedListing(overrides = {}) {
      const { agent, user } = await loggedInAgent();
      const listing = await createListing({
        owner: user,
        title: "Original title",
        location: "Goa",
        country: "India",
        image: {
          url: "https://res.cloudinary.test/dimora_DEV/old1.jpg",
          filename: "dimora_DEV/old1",
        },
        ...overrides,
      });
      return { agent, user, listing };
    }

    test("the edit form renders", async () => {
      const { agent, listing } = await ownedListing();
      const res = await agent.get(`/listings/${listing._id}/edit`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("Original title");
    });

    test("the edit form renders for a listing without an image", async () => {
      const { agent, listing } = await ownedListing({ image: undefined });
      await Listing.updateOne({ _id: listing._id }, { $unset: { image: "" } });
      const res = await agent.get(`/listings/${listing._id}/edit`);
      expect(res.status).toBe(200);
    });

    test("without a new image: succeeds, keeps the image, does not geocode or delete anything", async () => {
      const { agent, listing } = await ownedListing();
      const res = await putListing(
        agent,
        listing._id,
        fields({ "listing[title]": "Renamed", "listing[price]": "3100" }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${listing._id}`);
      const stored = await Listing.findById(listing._id);
      expect(stored.title).toBe("Renamed");
      expect(stored.pricing.nightlyMinor).toBe(310000);
      expect(stored.image.filename).toBe("dimora_DEV/old1");
      expect(geocoding.forwardGeocode).not.toHaveBeenCalled();
      expect(uploader.upload_stream).not.toHaveBeenCalled();
      expect(uploader.destroy).not.toHaveBeenCalled();
    });

    test("with a new image: stores it and deletes the old one from Cloudinary", async () => {
      const { agent, listing } = await ownedListing();
      const res = await putListing(agent, listing._id, fields(), {});
      expect(res.status).toBe(302);
      const stored = await Listing.findById(listing._id);
      expect(stored.image.filename).toMatch(/^dimora_DEV\/image\d+$/);
      expect(stored.image.filename).not.toBe("dimora_DEV/old1");
      expect(uploader.destroy).toHaveBeenCalledTimes(1);
      expect(uploader.destroy.mock.calls[0][0]).toBe("dimora_DEV/old1");
    });

    test("an old image outside our folder (seed data) is not sent to Cloudinary for deletion", async () => {
      const { agent, listing } = await ownedListing({
        image: {
          url: "https://images.unsplash.com/x",
          filename: "listingimage",
        },
      });
      await putListing(agent, listing._id, fields(), {});
      expect(uploader.destroy).not.toHaveBeenCalled();
    });

    test("changing the location geocodes again and updates the coordinates", async () => {
      const { agent, listing } = await ownedListing();
      geocoding.__setFeatures([
        { geometry: { type: "Point", coordinates: [73.85, 18.52] } },
      ]);
      const res = await putListing(
        agent,
        listing._id,
        fields({ "listing[location]": "Pune" }),
      );
      expect(res.status).toBe(302);
      expect(geocoding.forwardGeocode).toHaveBeenCalledWith({
        query: "Pune, India",
        limit: 1,
      });
      const stored = await Listing.findById(listing._id);
      expect(stored.location).toBe("Pune");
      expect([...stored.geometry.coordinates]).toEqual([73.85, 18.52]);
    });

    test("an unknown new location goes back to the edit form and changes nothing", async () => {
      const { agent, listing } = await ownedListing();
      geocoding.__noResults();
      const res = await putListing(
        agent,
        listing._id,
        fields({
          "listing[location]": "Qwxz",
          "listing[title]": "Should not save",
        }),
        {},
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${listing._id}/edit`);
      expect((await Listing.findById(listing._id)).title).toBe(
        "Original title",
      );
      expect(uploader.upload_stream).not.toHaveBeenCalled();
    });

    test("a listing saved without coordinates (old data) is geocoded on edit", async () => {
      const { agent, listing } = await ownedListing();
      await Listing.collection.updateOne(
        { _id: listing._id },
        { $unset: { geometry: "" } },
      );
      const res = await putListing(agent, listing._id, fields());
      expect(res.status).toBe(302);
      const stored = await Listing.findById(listing._id);
      expect(stored.geometry.coordinates).toHaveLength(2);
    });

    test("if saving fails after a new upload, the new image is deleted and the old one kept", async () => {
      const { agent, listing } = await ownedListing();
      jest
        .spyOn(Listing.prototype, "save")
        .mockRejectedValueOnce(new Error("db down"));
      const res = await putListing(agent, listing._id, fields(), {});
      expect(res.status).toBe(500);
      expect(uploader.destroy).toHaveBeenCalledTimes(1);
      expect(uploader.destroy.mock.calls[0][0]).toMatch(
        /^dimora_DEV\/image\d+$/,
      );
      expect(uploader.destroy.mock.calls[0][0]).not.toBe("dimora_DEV/old1");
    });

    test("another user cannot edit (403, nothing changed)", async () => {
      const { listing } = await ownedListing();
      const { agent: stranger } = await loggedInAgent();
      const res = await putListing(
        stranger,
        listing._id,
        fields({ "listing[title]": "Hijacked" }),
      );
      expect(res.status).toBe(403);
      expect((await Listing.findById(listing._id)).title).toBe(
        "Original title",
      );
    });

    test("a listing with no owner gives a 403, not a 500", async () => {
      const { agent, listing } = await ownedListing();
      await Listing.collection.updateOne(
        { _id: listing._id },
        { $unset: { owner: "" } },
      );
      const res = await agent.get(`/listings/${listing._id}/edit`);
      expect(res.status).toBe(403);
    });

    test("editing or deleting a listing that does not exist is a 404", async () => {
      const { agent } = await loggedInAgent();
      const missing = new mongoose.Types.ObjectId();
      expect((await agent.get(`/listings/${missing}/edit`)).status).toBe(404);
      expect((await putListing(agent, missing, fields())).status).toBe(404);
      expect((await agent.delete(`/listings/${missing}`)).status).toBe(404);
    });
  });

  test("create → edit → delete works on a clean database", async () => {
    const { agent } = await loggedInAgent();

    expect((await postListing(agent, fields(), {})).status).toBe(302);
    const created = await Listing.findOne({ title: "Seaside Cottage" });
    expect(created).not.toBeNull();

    const edited = await putListing(
      agent,
      created._id,
      fields({ "listing[title]": "Seaside Cottage (updated)" }),
    );
    expect(edited.status).toBe(302);
    expect((await Listing.findById(created._id)).title).toBe(
      "Seaside Cottage (updated)",
    );

    const deleted = await agent.delete(`/listings/${created._id}`);
    expect(deleted.status).toBe(302);
    expect(deleted.headers.location).toBe("/listings");
    // soft delete (P04-T05): the row stays, but nobody can see the listing
    const stored = await Listing.findById(created._id);
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect((await agent.get(`/listings/${created._id}`)).status).toBe(302);
  });
});
