// P04-T07: small pure helpers behind the listing page.
const { groupAmenities, amenityLabel } = require("../../src/utils/amenities");
const { summarizeRatings } = require("../../src/utils/ratings");
const { listingJsonLd, safeJson } = require("../../src/utils/structuredData");
const { AMENITIES, AMENITY_GROUPS } = require("../../src/config/constants");

describe("groupAmenities", () => {
  test("groups in a fixed order, labels not keys", () => {
    expect(
      groupAmenities(["pool", "wifi", "smoke_alarm", "pets_allowed"]),
    ).toEqual([
      { group: "Essentials", items: ["Wi-Fi"] },
      { group: "Facilities", items: ["Pool"] },
      { group: "Safety", items: ["Smoke alarm"] },
      { group: "Good to know", items: ["Pets allowed"] },
    ]);
  });
  test("empty groups are left out; unknown keys and duplicates are dropped", () => {
    expect(
      groupAmenities(["wifi", "wifi", "jacuzzi", "__proto__", 5, null]),
    ).toEqual([{ group: "Essentials", items: ["Wi-Fi"] }]);
  });
  test.each([undefined, null, [], "wifi", {}, 5])(
    "nothing usable (%p) -> []",
    (value) => {
      expect(groupAmenities(value)).toEqual([]);
    },
  );
  test("every known amenity belongs to a known group", () => {
    for (const item of AMENITIES) expect(AMENITY_GROUPS).toContain(item.group);
  });
  test("all amenities together appear exactly once", () => {
    const all = groupAmenities(AMENITIES.map((a) => a.value)).flatMap(
      (g) => g.items,
    );
    expect(all).toHaveLength(AMENITIES.length);
    expect(new Set(all).size).toBe(AMENITIES.length);
  });
  test("amenityLabel", () => {
    expect(amenityLabel("wifi")).toBe("Wi-Fi");
    expect(amenityLabel("nope")).toBeNull();
    expect(amenityLabel(undefined)).toBeNull();
  });
});

describe("summarizeRatings", () => {
  test("average with one decimal", () => {
    expect(
      summarizeRatings([{ rating: 5 }, { rating: 4 }, { rating: 4 }]),
    ).toEqual({ average: 4.3, count: 3 });
    expect(summarizeRatings([{ rating: 5 }])).toEqual({ average: 5, count: 1 });
    expect(summarizeRatings([{ rating: 1 }, { rating: 2 }])).toEqual({
      average: 1.5,
      count: 2,
    });
  });
  test("no reviews, or nothing usable: no average, count 0", () => {
    for (const input of [[], undefined, null, "x", {}]) {
      expect(summarizeRatings(input)).toEqual({ average: null, count: 0 });
    }
  });
  test("ratings that are not whole numbers 1-5 are ignored, never counted as 0", () => {
    const reviews = [
      { rating: 5 },
      { rating: 0 },
      { rating: 6 },
      { rating: "4" },
      { rating: 4.5 },
      {},
      null,
      { rating: NaN },
    ];
    expect(summarizeRatings(reviews)).toEqual({ average: 5, count: 1 });
  });
});

describe("structured data", () => {
  const listing = {
    title: "Sea View",
    description: "A quiet flat. ".repeat(100),
    address: {
      line1: "12 Secret Street",
      city: "Goa",
      state: "Goa",
      country: "India",
    },
    geometry: { type: "Point", coordinates: [73.8, 15.5] },
    pricing: { nightlyMinor: 250000 },
    amenities: ["wifi", "pool", "jacuzzi"],
  };
  const gallery = [
    { url: "https://res.cloudinary.com/d/image/upload/v1/a.jpg" },
  ];

  test("a LodgingBusiness with the public facts", () => {
    const data = JSON.parse(
      listingJsonLd(listing, { gallery, rating: { average: 4.5, count: 2 } }),
    );
    expect(data["@type"]).toBe("LodgingBusiness");
    expect(data.name).toBe("Sea View");
    expect(data.description.length).toBeLessThanOrEqual(500);
    expect(data.image[0]).toBe(
      "https://res.cloudinary.com/d/image/upload/w_1600,f_auto,q_auto/v1/a.jpg",
    );
    expect(data.address).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Goa",
      addressRegion: "Goa",
      addressCountry: "India",
    });
    expect(data.priceRange).toBe("₹2,500 per night");
    expect(data.amenityFeature.map((f) => f.name)).toEqual(["Wi-Fi", "Pool"]);
    expect(data.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.5,
      reviewCount: 2,
      bestRating: 5,
      worstRating: 1,
    });
  });
  test("the street address and the exact point are never included", () => {
    const text = listingJsonLd(listing, { gallery });
    expect(text).not.toContain("Secret Street");
    expect(text).not.toContain("73.8");
    expect(text).not.toContain("15.5");
    expect(text).not.toContain("geo");
  });
  test("no reviews means no rating block", () => {
    expect(
      JSON.parse(
        listingJsonLd(listing, { rating: { average: null, count: 0 } }),
      ),
    ).not.toHaveProperty("aggregateRating");
    expect(JSON.parse(listingJsonLd(listing))).not.toHaveProperty(
      "aggregateRating",
    );
  });
  test("a bare listing still gives valid JSON with only what exists", () => {
    const data = JSON.parse(listingJsonLd({ title: "T", description: "" }));
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "LodgingBusiness",
      name: "T",
    });
  });
  test("the text cannot break out of a script element", () => {
    const text = listingJsonLd({
      title: "</script><script>alert(1)</script>",
      description: "a & b <b>x</b>\u2028",
    });
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text).name).toBe("</script><script>alert(1)</script>");
  });
  test("at most 10 images", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      url: `https://x/${i}.jpg`,
    }));
    expect(
      JSON.parse(listingJsonLd(listing, { gallery: many })).image,
    ).toHaveLength(10);
  });
  test("safeJson escapes the dangerous characters and round-trips", () => {
    const value = { a: "<>&\u2028\u2029'\"" };
    expect(JSON.parse(safeJson(value))).toEqual(value);
    expect(safeJson(value)).not.toMatch(/[<>&\u2028\u2029]/);
  });
});
