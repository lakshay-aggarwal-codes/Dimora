// P04-T07: the public listing page with the least and the most data, and who
// may see it. No database: the model is stubbed (plain objects stand in for
// populated documents).
const { createAgent } = require("../helpers/agent");
const Listing = require("../../src/models/listing");
const { buildListingData } = require("../helpers/factories");

function stubFindById(doc) {
  const query = {
    populate: () => query,
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
  };
  return jest.spyOn(Listing, "findById").mockReturnValue(query);
}
const count = (html, re) => (html.match(re) || []).length;
const jsonLd = (html) => {
  const match = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  return match ? JSON.parse(match[1]) : null;
};
afterEach(() => jest.restoreAllMocks());

const MIN = (extra = {}) => ({
  _id: "64b0f0f0f0f0f0f0f0f0aaaa",
  status: "published",
  title: "T",
  description: "d",
  reviews: [],
  ...extra,
});

const MAX = () => ({
  _id: "64b0f0f0f0f0f0f0f0f0bbbb",
  status: "published",
  title: `Sunny seafront flat ${"with a very long title ".repeat(8)}"quoted" <b>bold</b>`,
  description: `Line one\nLine two <script>alert(1)</script> ${"words ".repeat(300)}`,
  location: "Goa",
  country: "India",
  address: {
    line1: "12 Secret Street",
    city: "Goa",
    state: "Goa",
    country: "India",
  },
  geometry: { type: "Point", coordinates: [73.8, 15.5] },
  owner: {
    _id: "64b0f0f0f0f0f0f0f0f0cccc",
    username: "ann",
    displayName: "Ann <i>Host</i>",
    createdAt: new Date("2023-05-01T00:00:00Z"),
  },
  images: Array.from({ length: 10 }, (_, i) => ({
    _id: `64b0f0f0f0f0f0f0f0f0d0${i}0`.slice(0, 24),
    url: `https://res.cloudinary.com/demo/image/upload/v1/p${i}.jpg`,
    publicId: `p${i}`,
    alt: i === 0 ? 'Sea "view" <b>' : "",
    caption: i === 1 ? "The terrace" : "",
    order: i,
  })),
  propertyType: "apartment",
  roomType: "entire_place",
  capacity: { guests: 16, bedrooms: 8, beds: 12, bathrooms: 4.5 },
  amenities: [
    "wifi",
    "kitchen",
    "washer",
    "air_conditioning",
    "heating",
    "tv",
    "workspace",
    "free_parking",
    "pool",
    "gym",
    "balcony",
    "smoke_alarm",
    "first_aid_kit",
    "pets_allowed",
  ],
  pricing: { nightlyMinor: 12345600, currency: "INR" },
  minNights: 2,
  maxNights: 30,
  checkInTime: "14:00",
  checkOutTime: "11:00",
  cancellationPolicy: "strict",
  instantBook: false,
  houseRules: `No parties. <script>x</script>\n${"Quiet hours. ".repeat(100)}`,
  noSpecialRules: false,
  reviews: Array.from({ length: 30 }, (_, i) => ({
    _id: `64b0f0f0f0f0f0f0f0f0e${String(i).padStart(3, "0")}`,
    rating: (i % 5) + 1,
    comment: i === 0 ? "<img src=x onerror=alert(1)> great" : `Review ${i}`,
    author:
      i % 7 === 0
        ? null
        : { _id: "64b0f0f0f0f0f0f0f0f0ffff", username: `guest${i}` },
  })),
});

describe("the least data", () => {
  test("a bare published listing renders every required part and no empty sections", async () => {
    stubFindById(MIN());
    const res = await createAgent().get("/listings/64b0f0f0f0f0f0f0f0f0aaaa");
    expect(res.status).toBe(200);
    expect(count(res.text, /<h1>/g)).toBe(1);
    expect(res.text).toContain("About this place");
    expect(res.text).toContain("Price not available");
    expect(res.text).toContain("No reviews yet.");
    expect(res.text).toContain(
      "The map is not available for this listing yet.",
    );
    expect(res.text).toContain("data-booking-slot");
    for (const absent of [
      "key-facts",
      "host-card",
      "amenities-heading",
      "rules-heading",
      "review-summary",
      "detail-meta",
      "undefined",
      "NaN",
      "null",
    ]) {
      expect(res.text).not.toContain(absent);
    }
  });

  test("a document with only the required fields (model defaults) renders too", async () => {
    const doc = new Listing(buildListingData({ status: "published" }));
    stubFindById(doc);
    const res = await createAgent().get(`/listings/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Key facts");
    expect(res.text).not.toMatch(/undefined|NaN/);
  });

  test("structured data for a bare listing is small but valid", async () => {
    stubFindById(MIN());
    const data = jsonLd(
      (await createAgent().get("/listings/64b0f0f0f0f0f0f0f0f0aaaa")).text,
    );
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "LodgingBusiness",
      name: "T",
      description: "d",
    });
  });
});

describe("the most data", () => {
  let html;
  beforeAll(async () => {
    jest.restoreAllMocks();
    stubFindById(MAX());
    html = (await createAgent().get("/listings/64b0f0f0f0f0f0f0f0f0bbbb")).text;
  });

  test("every section is there once, with a labelled heading", () => {
    expect(count(html, /<h1>/g)).toBe(1);
    for (const id of [
      "about-heading",
      "host-heading",
      "amenities-heading",
      "rules-heading",
      "summary-heading",
      "map-heading",
      "reviews-heading",
    ]) {
      expect(count(html, new RegExp(`id="${id}"`, "g"))).toBe(1);
      expect(html).toContain(`aria-labelledby="${id}"`);
    }
  });

  test("key facts use plural and singular words and icons are decorative", () => {
    expect(html).toContain("16 guests");
    expect(html).toContain("8 bedrooms");
    expect(html).toContain("12 beds");
    expect(html).toContain("4.5 bathrooms");
    expect(html).toMatch(/<i class="fa-solid fa-bed" aria-hidden="true">/);
  });

  test("the type line, price and gallery", () => {
    expect(html).toContain("The whole place · Apartment");
    expect(html).toContain("₹1,23,456");
    expect(html).toContain("Show all 10 photos");
    expect(html).toContain('data-alt="Sea &#34;view&#34; &lt;b&gt;"');
  });

  test("the host card", () => {
    expect(html).toContain("Hosted by Ann &lt;i&gt;Host&lt;/i&gt;");
    expect(html).toContain("Member since 2023");
    expect(html).toMatch(/host-avatar" aria-hidden="true">A</);
  });

  test("amenities grouped under their headings", () => {
    for (const heading of [
      "Essentials",
      "Facilities",
      "Safety",
      "Good to know",
    ]) {
      expect(html).toContain(
        `<h3 class="h6 amenity-group-title">${heading}</h3>`,
      );
    }
    expect(count(html, /<ul class="amenity-list">/g)).toBe(4);
    expect(html).toContain("<li>Wi-Fi</li>");
    expect(html).toContain("<li>Pets allowed</li>");
  });

  test("things to know", () => {
    expect(html).toContain("<dt>Check-in</dt><dd>from 14:00</dd>");
    expect(html).toContain("<dt>Check-out</dt><dd>by 11:00</dd>");
    expect(html).toContain("2 to 30 nights");
    expect(html).toContain("<dt>Cancellation</dt><dd>Strict</dd>");
    expect(html).toContain("The host approves each request");
    expect(html).toContain('<h3 class="h6">House rules</h3>');
  });

  test("the rating summary and the review cards", () => {
    expect(html).toContain('href="#reviews-heading"');
    expect(count(html, /class="review-card"/g)).toBe(30);
    expect(html).toContain("Rated 3.0 out of 5 from 30 reviews");
    expect(html).toContain("@ Unknown User");
  });

  test("nothing from the host or the guests is run as markup", () => {
    expect(html).not.toMatch(
      /<script>alert\(1\)<\/script>|<script>x<\/script>|<img src=x|<b>bold<\/b>|<i>Host<\/i>/,
    );
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; great");
  });

  test("structured data: parses, is public facts only, one aggregate rating", () => {
    const data = jsonLd(html);
    expect(data["@type"]).toBe("LodgingBusiness");
    expect(data.name).toContain("Sunny seafront flat");
    expect(data.image).toHaveLength(10);
    expect(data.aggregateRating.reviewCount).toBe(30);
    expect(data.amenityFeature).toHaveLength(14);
    expect(html).not.toContain("Secret Street");
    expect(count(html, /application\/ld\+json/g)).toBe(1);
  });
});

describe("structured data is only for what the public can see", () => {
  test("a markup-heavy title cannot close the JSON-LD element", async () => {
    stubFindById(MIN({ title: "</script><script>alert(1)</script>" }));
    const res = await createAgent().get("/listings/64b0f0f0f0f0f0f0f0f0aaaa");
    expect(res.status).toBe(200);
    expect(jsonLd(res.text).name).toBe("</script><script>alert(1)</script>");
    expect(res.text).not.toContain("</script><script>alert(1)</script>");
  });
});

describe("who can open the page (404 otherwise)", () => {
  test.each([
    ["a draft", { status: "draft" }],
    ["an unpublished listing", { status: "unpublished" }],
    ["a deleted listing", { deletedAt: new Date() }],
    ["a suspended listing", { status: "suspended" }],
  ])(
    "%s is a 404 for a visitor and says nothing about it",
    async (_name, patch) => {
      stubFindById(MIN({ title: "Very secret title", ...patch }));
      const res = await createAgent().get("/listings/64b0f0f0f0f0f0f0f0f0aaaa");
      expect(res.status).toBe(404);
      expect(res.text).not.toContain("Very secret title");
      expect(res.text).not.toContain("ld+json");
    },
  );

  test("a listing that does not exist, and a value that is not an id, are 404", async () => {
    stubFindById(null);
    expect(
      (await createAgent().get("/listings/64b0f0f0f0f0f0f0f0f0aaaa")).status,
    ).toBe(404);
    expect((await createAgent().get("/listings/not-an-id")).status).toBe(404);
  });

  test("the 404 page is the normal error page, with the page shell", async () => {
    stubFindById(null);
    const res = await createAgent().get("/listings/64b0f0f0f0f0f0f0f0f0aaaa");
    expect(res.text).toContain('<main id="main"');
    expect(res.text).toMatch(/<title>[^<]*404/);
  });
});
