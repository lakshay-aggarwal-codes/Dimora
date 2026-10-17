// P04-T02 through the real routes (listing wizard), with Cloudinary and Mapbox
// mocked. Needs a MongoDB (see tests/helpers/db.js); skipped with SKIP_DB_TESTS=1.
const { describeDb, useTestDb } = require("../helpers/db");
const { createAgent, login } = require("../helpers/agent");
const { createUser, createListing } = require("../helpers/factories");
const { geocoding, resetExternalMocks } = require("../helpers/mocks");
const Listing = require("../../src/models/listing");

const pad = (head, total = 64) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(total - head.length)]);
const JPEG = () => pad([0xff, 0xd8, 0xff, 0xe0]);

const BASICS = {
  title: "Sunny flat by the sea",
  description: "A bright two-room flat a minute from the beach.",
  propertyType: "apartment",
  roomType: "entire_place",
};
const LOCATION = {
  line1: "12 Beach Road",
  city: "Goa",
  state: "Goa",
  country: "India",
  postalCode: "403001",
};
const DETAILS = {
  guests: "4",
  bedrooms: "2",
  beds: "3",
  bathrooms: "1.5",
  amenities: ["wifi", "kitchen"],
};
const PRICING = {
  price: "2500",
  cleaningFee: "300",
  minNights: "1",
  maxNights: "30",
  checkInTime: "14:00",
  checkOutTime: "11:00",
  cancellationPolicy: "moderate",
  instantBook: "on",
  houseRules: "No smoking.",
};

const TOKEN = /name="draftToken" value="([0-9a-f-]{36})"/;

async function host() {
  const { user, password } = await createUser();
  const agent = await login(createAgent(), {
    username: user.username,
    password,
  });
  return { agent, user };
}

async function startDraft(agent, body = BASICS) {
  const form = await agent.get("/host/listings/new");
  const draftToken = TOKEN.exec(form.text)[1];
  const res = await agent
    .post("/host/listings")
    .type("form")
    .send({ ...body, draftToken });
  return { res, draftToken };
}

const stepUrl = (listing, n) => `/host/listings/${listing._id}/steps/${n}`;
const post = (agent, listing, n, body) =>
  agent.post(stepUrl(listing, n)).type("form").send(body);

async function draftAtStep(agent, upTo) {
  const { res } = await startDraft(agent);
  const id = /\/host\/listings\/([0-9a-f]{24})\/steps\/2/.exec(
    res.headers.location,
  )[1];
  let listing = await Listing.findById(id);
  if (upTo >= 2) await post(agent, listing, 2, LOCATION);
  if (upTo >= 3) await post(agent, listing, 3, DETAILS);
  if (upTo >= 4) {
    await agent
      .post(`/listings/${id}/images?wizard=1`)
      .attach("photos", JPEG(), {
        filename: "a.jpg",
        contentType: "image/jpeg",
      });
    await post(agent, listing, 4, {});
  }
  if (upTo >= 5) await post(agent, listing, 5, PRICING);
  listing = await Listing.findById(id);
  return listing;
}

// The wizard only checks that each step was saved; publishing also needs the
// Host Readiness Checklist (P04-T05): 5 photos and a 200-character description.
async function makeReady(listing) {
  const images = [1, 2, 3, 4, 5].map((n) => ({
    url: `https://res.cloudinary.test/dimora_DEV/ready${n}.jpg`,
    publicId: `dimora_DEV/ready${n}`,
    alt: "",
    caption: "",
    order: n - 1,
  }));
  await Listing.updateOne(
    { _id: listing._id },
    {
      $set: {
        images,
        "image.url": images[0].url,
        "image.filename": images[0].publicId,
        description: `${BASICS.description} `.repeat(6),
      },
    },
  );
  return Listing.findById(listing._id);
}

beforeEach(() => geocoding.forwardGeocode.mockClear());
afterEach(resetExternalMocks);

describeDb("listing wizard", () => {
  useTestDb();

  describe("starting", () => {
    test("anonymous visitors are sent to /login", async () => {
      const res = await createAgent().get("/host/listings/new");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login");
    });

    test("step 1 shows the stepper with only step 1 open", async () => {
      const { agent } = await host();
      const res = await agent.get("/host/listings/new");
      expect(res.status).toBe(200);
      expect(res.text).toContain("Step 1 of 6: The basics");
      expect(res.text).toContain('aria-label="Listing steps"');
      expect(res.text).toMatch(/aria-current="step"/);
      expect(res.text).not.toContain("/steps/2");
    });

    test("invalid basics come back with messages and the typed values; nothing is saved", async () => {
      const { agent } = await host();
      const { res } = await startDraft(agent, {
        ...BASICS,
        title: "Hi",
        propertyType: "castle",
      });
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/Title must be at least 5 characters/);
      expect(res.text).toMatch(/Choose property type from the list/);
      expect(res.text).toContain("A bright two-room flat");
      expect(await Listing.countDocuments()).toBe(0);
    });

    test("valid basics make a private draft owned by the host and go to step 2", async () => {
      const { agent, user } = await host();
      const { res } = await startDraft(agent);
      expect(res.status).toBe(302);
      const draft = await Listing.findOne();
      expect(res.headers.location).toBe(stepUrl(draft, 2));
      expect(draft.status).toBe("draft");
      expect(String(draft.owner)).toBe(String(user._id));
      expect([...draft.wizardSteps]).toEqual([1]);
      expect(draft.title).toBe(BASICS.title);
    });

    test("submitting the first step twice makes one draft", async () => {
      const { agent } = await host();
      const form = await agent.get("/host/listings/new");
      const draftToken = TOKEN.exec(form.text)[1];
      const send = () =>
        agent
          .post("/host/listings")
          .type("form")
          .send({ ...BASICS, draftToken });
      const first = await send();
      const second = await send();
      expect(second.headers.location).toBe(first.headers.location);
      expect(await Listing.countDocuments()).toBe(1);
    });

    test("a malformed form token is refused", async () => {
      const { agent } = await host();
      const res = await agent
        .post("/host/listings")
        .type("form")
        .send({ ...BASICS, draftToken: "../../etc" });
      expect(res.status).toBe(400);
      expect(await Listing.countDocuments()).toBe(0);
    });
  });

  describe("order of steps (no skipping)", () => {
    test("a later step redirects to the first unfinished one with a message", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 1);
      const res = await agent.get(stepUrl(draft, 4));
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(stepUrl(draft, 2));
      const page = await agent.get(stepUrl(draft, 2));
      expect(page.text).toContain("Please finish step 2 first.");
    });

    test("saving a later step directly changes nothing", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 1);
      const res = await post(agent, draft, 5, PRICING);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(stepUrl(draft, 2));
      const stored = await Listing.findById(draft._id);
      expect(stored.pricing.nightlyMinor).toBeUndefined();
      expect([...stored.wizardSteps]).toEqual([1]);
    });

    test("cannot publish an incomplete draft", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 3);
      const res = await agent.post(`/host/listings/${draft._id}/publish`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(stepUrl(draft, 4));
      expect((await Listing.findById(draft._id)).status).toBe("draft");
    });

    test("step numbers outside 1-6 are a 404", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 1);
      expect((await agent.get(stepUrl(draft, 9))).status).toBe(404);
      expect((await agent.get(stepUrl(draft, "abc"))).status).toBe(404);
      expect((await post(agent, draft, 6, {})).status).toBe(404);
    });

    test("/host/listings/:id resumes at the first unfinished step", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 3);
      const res = await agent.get(`/host/listings/${draft._id}`);
      expect(res.headers.location).toBe(stepUrl(draft, 4));
    });
  });

  describe("step 2: location", () => {
    test("looks the address up and stores the point; the street address stays out of the public text", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 1);
      geocoding.__setFeatures([
        { geometry: { type: "Point", coordinates: [73.8, 15.5] } },
      ]);
      const res = await post(agent, draft, 2, LOCATION);
      expect(res.headers.location).toBe(stepUrl(draft, 3));
      const stored = await Listing.findById(draft._id);
      expect(stored.geometry.coordinates).toEqual([73.8, 15.5]);
      expect(stored.address.line1).toBe("12 Beach Road");
      expect(stored.location).toBe("Goa, Goa");
      expect(geocoding.forwardGeocode.mock.calls[0][0].query).toContain(
        "12 Beach Road",
      );
    });

    test("an address Mapbox cannot find is a message on the form; nothing is saved", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 1);
      geocoding.__noResults();
      const res = await post(agent, draft, 2, LOCATION);
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/couldn&#39;t find that location/i);
      expect(res.text).toContain("12 Beach Road");
      const stored = await Listing.findById(draft._id);
      expect(stored.address.line1).toBeUndefined();
      expect([...stored.wizardSteps]).toEqual([1]);
    });

    test("a Mapbox outage says to try again and does not leak the error", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 1);
      geocoding.__failWith(new Error("ECONNRESET"));
      const res = await post(agent, draft, 2, LOCATION);
      expect(res.status).toBe(503);
      expect(res.text).toMatch(/temporarily unavailable/i);
      expect(res.text).not.toMatch(/ECONNRESET/);
    });

    test("saving the same address again does not call the geocoder", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 2);
      geocoding.forwardGeocode.mockClear();
      await post(agent, draft, 2, LOCATION);
      expect(geocoding.forwardGeocode).not.toHaveBeenCalled();
    });
  });

  describe("steps 3 and 5", () => {
    test("invalid details are refused with messages", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 2);
      const res = await post(agent, draft, 3, {
        ...DETAILS,
        guests: "0",
        bathrooms: "1.3",
      });
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/Guests must be at least 1/);
      expect(res.text).toMatch(/Bathrooms can be a whole or half number/);
    });

    test("an unknown amenity is refused", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 2);
      const res = await post(agent, draft, 3, {
        ...DETAILS,
        amenities: ["wifi", "jetpack"],
      });
      expect(res.status).toBe(400);
      expect((await Listing.findById(draft._id)).amenities).toHaveLength(0);
    });

    test("the price is stored in paise and refuses less than INR 100", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 4);
      const low = await post(agent, draft, 5, { ...PRICING, price: "99" });
      expect(low.status).toBe(400);
      expect(low.text).toMatch(/Nightly price must be at least ₹100/);
      const ok = await post(agent, draft, 5, PRICING);
      expect(ok.headers.location).toBe(stepUrl(draft, 6));
      const stored = await Listing.findById(draft._id);
      expect(stored.pricing.nightlyMinor).toBe(250000);
      expect(stored.pricing.cleaningFeeMinor).toBe(30000);
      expect(stored.instantBook).toBe(true);
    });

    test("minimum nights above maximum nights is refused", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 4);
      const res = await post(agent, draft, 5, {
        ...PRICING,
        minNights: "9",
        maxNights: "2",
      });
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/cannot be more than/);
    });

    test("fields that do not belong to the step cannot be smuggled in", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 4);
      const res = await post(agent, draft, 5, {
        ...PRICING,
        status: "published",
        owner: "x",
      });
      expect(res.status).toBe(400);
      expect((await Listing.findById(draft._id)).status).toBe("draft");
    });
  });

  describe("step 4: photos", () => {
    test("continuing without a photo is refused", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 3);
      const res = await post(agent, draft, 4, {});
      expect(res.status).toBe(400);
      expect(res.text).toContain("Add at least one photo before you continue.");
    });

    test("uploading returns to the wizard, and then continuing works", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 3);
      const up = await agent
        .post(`/listings/${draft._id}/images?wizard=1`)
        .attach("photos", JPEG(), {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });
      expect(up.headers.location).toBe(stepUrl(draft, 4));
      const page = await agent.get(stepUrl(draft, 4));
      expect(page.text).toContain("1 photo added.");
      expect(page.text).toContain("?_method=PUT&amp;wizard=1");
      const next = await post(agent, draft, 4, {});
      expect(next.headers.location).toBe(stepUrl(draft, 5));
    });

    test("the plain edit-page upload still returns to the edit page", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 3);
      const up = await agent
        .post(`/listings/${draft._id}/images`)
        .attach("photos", JPEG(), {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });
      expect(up.headers.location).toBe(`/listings/${draft._id}/edit#photos`);
    });
  });

  describe("privacy and permissions", () => {
    test("someone else's draft is forbidden at every step and cannot be published", async () => {
      const { agent: owner } = await host();
      const draft = await draftAtStep(owner, 4);
      const { agent: stranger } = await host();
      expect((await stranger.get(stepUrl(draft, 2))).status).toBe(403);
      expect((await post(stranger, draft, 2, LOCATION)).status).toBe(403);
      expect(
        (await stranger.post(`/host/listings/${draft._id}/publish`)).status,
      ).toBe(403);
    });

    test("a draft is not listed, not on the home page, and not viewable by others", async () => {
      const { agent: owner } = await host();
      const draft = await draftAtStep(owner, 4);
      const anon = createAgent();
      expect((await anon.get("/listings")).text).not.toContain(BASICS.title);
      expect((await anon.get("/")).text).not.toContain(BASICS.title);
      const direct = await anon.get(`/listings/${draft._id}`);
      expect(direct.status).toBe(302);
      expect(direct.headers.location).toBe("/listings");
      const { agent: stranger } = await host();
      expect((await stranger.get(`/listings/${draft._id}`)).status).toBe(302);
    });

    test("the host can preview their own draft", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 4);
      const res = await agent.get(`/listings/${draft._id}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain(BASICS.title);
    });

    test("an unpublished listing also looks missing to visitors", async () => {
      const { user } = await host();
      const listing = await createListing({
        owner: user._id,
        status: "unpublished",
      });
      const res = await createAgent().get(`/listings/${listing._id}`);
      expect(res.status).toBe(302);
      expect((await createAgent().get("/listings")).text).not.toContain(
        listing.title,
      );
    });

    test("a published listing is not editable in the wizard: it points to the edit page", async () => {
      const { agent, user } = await host();
      const listing = await createListing({ owner: user._id });
      const res = await agent.get(stepUrl(listing, 1));
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${listing._id}/edit`);
    });
  });

  describe("review and publish", () => {
    test("the review lists what was entered, escaped, and offers Publish", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 5);
      await makeReady(draft);
      await Listing.updateOne(
        { _id: draft._id },
        {
          description: `<script>alert(1)</script> ${"more words ".repeat(30)}`,
        },
      );
      const res = await agent.get(stepUrl(draft, 6));
      expect(res.status).toBe(200);
      expect(res.text).toContain("Step 6 of 6: Review and publish");
      expect(res.text).toContain("₹2,500 per night");
      expect(res.text).toContain("Wi-Fi, Kitchen");
      expect(res.text).not.toContain("<script>alert(1)");
      expect(res.text).not.toMatch(/ disabled aria-disabled/);
    });

    test("a draft with every step saved but a short checklist is refused, with the reasons", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 5); // 1 photo, 49-character description
      const res = await agent.post(`/host/listings/${draft._id}/publish`);
      expect(res.status).toBe(302);
      expect((await Listing.findById(draft._id)).status).toBe("draft");
      const page = await agent.get(res.headers.location);
      expect(page.text).toContain("not ready to publish");
      expect(page.text).toContain("At least 5 photos");
    });

    test("the review step shows the checklist and keeps Publish disabled until it is done", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 5);
      const res = await agent.get(stepUrl(draft, 6));
      expect(res.text).toContain("Ready to publish?");
      expect(res.text).toMatch(/ disabled aria-disabled/);
      expect(res.text).toContain("Preview as a guest");
    });

    test("publishing a finished draft makes it public everywhere", async () => {
      const { agent } = await host();
      const draft = await makeReady(await draftAtStep(agent, 5));
      const res = await agent.post(`/host/listings/${draft._id}/publish`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/listings/${draft._id}`);
      expect((await Listing.findById(draft._id)).status).toBe("published");
      const anon = createAgent();
      expect((await anon.get("/listings")).text).toContain(BASICS.title);
      expect((await anon.get(`/listings/${draft._id}`)).status).toBe(200);
      expect((await anon.get("/")).text).toContain(BASICS.title);
    });

    test("publishing twice is harmless", async () => {
      const { agent } = await host();
      const draft = await makeReady(await draftAtStep(agent, 5));
      await agent.post(`/host/listings/${draft._id}/publish`);
      const again = await agent.post(`/host/listings/${draft._id}/publish`);
      expect(again.status).toBe(302);
      expect(await Listing.countDocuments({ status: "published" })).toBe(1);
    });

    test("removing the photo after step 4 blocks publishing again", async () => {
      const { agent } = await host();
      const draft = await makeReady(await draftAtStep(agent, 5));
      await Listing.updateOne(
        { _id: draft._id },
        { $set: { images: [] }, $unset: { image: 1 } },
      );
      const res = await agent.post(`/host/listings/${draft._id}/publish`);
      expect(res.headers.location).toBe(stepUrl(draft, 4));
      expect((await Listing.findById(draft._id)).status).toBe("draft");
    });

    test("going back to change an earlier step keeps later steps finished", async () => {
      const { agent } = await host();
      const draft = await draftAtStep(agent, 5);
      const res = await post(agent, draft, 1, {
        ...BASICS,
        title: "A new title for the flat",
      });
      expect(res.headers.location).toBe(stepUrl(draft, 2));
      const stored = await Listing.findById(draft._id);
      expect(stored.title).toBe("A new title for the flat");
      expect([...stored.wizardSteps]).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
