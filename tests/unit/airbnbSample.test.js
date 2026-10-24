const { mapListing, unwrap, amenitiesOf } = require("../../scripts/lib/airbnb-sample");
const { parseArgs } = require("../../scripts/import-dataset");

const source = () => ({
  _id: "10006546",
  name: "Ribeira Charming Duplex",
  summary: "Short summary",
  description: "Fantastic duplex apartment",
  house_rules: "Make the house your home...",
  property_type: "House",
  room_type: "Entire home/apt",
  minimum_nights: "2",
  maximum_nights: "30",
  cancellation_policy: "strict_14_with_grace_period",
  accommodates: { $numberInt: "8" },
  bedrooms: { $numberInt: "3" },
  beds: { $numberInt: "5" },
  bathrooms: { $numberDecimal: "1.0" },
  amenities: ["TV", "Wifi", "Kitchen", "Pets allowed", "Hangers", "Washer"],
  price: { $numberDecimal: "80.00" },
  cleaning_fee: { $numberDecimal: "35.00" },
  images: { picture_url: "https://a0.muscache.com/im/pictures/x.jpg" },
  address: {
    street: "Porto, Porto, Portugal",
    market: "Porto",
    country: "Portugal",
    location: { type: "Point", coordinates: [{ $numberDouble: "-8.61308" }, { $numberDouble: "41.1413" }] },
  },
});
const opts = { ownerId: "owner1", usdToInr: 85 };

describe("airbnb sample mapper", () => {
  test("unwraps extended JSON numbers", () => {
    expect(unwrap({ $numberInt: "8" })).toBe(8);
    expect(unwrap({ $numberDecimal: "80.00" })).toBe(80);
    expect(unwrap({ $date: { $numberLong: "1451797200000" } }).getTime()).toBe(1451797200000);
  });

  test("maps a record to a v2 listing in paise", () => {
    const { doc } = mapListing(source(), opts);
    expect(doc.title).toBe("Ribeira Charming Duplex");
    expect(doc.status).toBe("published");
    expect(doc.pricing).toEqual({ nightlyMinor: 680000, cleaningFeeMinor: 297500, currency: "INR" });
    expect(doc.geometry.coordinates).toEqual([-8.61308, 41.1413]);
    expect(doc.address).toEqual({ city: "Porto", state: "", country: "Portugal" });
    expect(doc.cityKey).toBe("porto");
    expect(doc.propertyType).toBe("house");
    expect(doc.roomType).toBe("entire_place");
    expect(doc.cancellationPolicy).toBe("strict");
    expect(doc.capacity).toEqual({ guests: 8, bedrooms: 3, beds: 5, bathrooms: 1 });
    expect(doc.minNights).toBe(2);
    expect(doc.importedFrom).toEqual({ source: "sample_airbnb", id: "10006546" });
    expect(doc.owner).toBe("owner1");
  });

  test("keeps only amenities Dimora knows", () => {
    expect(amenitiesOf(source().amenities)).toEqual(["tv", "wifi", "kitchen", "pets_allowed", "washer"]);
  });

  test("skips records that cannot be shown or booked", () => {
    const noPrice = source();
    delete noPrice.price;
    expect(mapListing(noPrice, opts).skipped).toBe("no price");
    const noCoords = source();
    noCoords.address.location.coordinates = [0, 0];
    expect(mapListing(noCoords, opts).skipped).toBe("no usable coordinates");
    const noPicture = source();
    noPicture.images.picture_url = "";
    expect(mapListing(noPicture, opts).skipped).toBe("no picture");
    const cheap = source();
    cheap.price = { $numberDecimal: "0.50" };
    expect(mapListing(cheap, opts).skipped).toBe("price out of range");
  });

  test("a minimum longer than the maximum is raised, never inverted", () => {
    const s = source();
    s.minimum_nights = "40";
    s.maximum_nights = "30";
    const { doc } = mapListing(s, opts);
    expect(doc.minNights <= doc.maxNights).toBe(true);
  });
});

describe("import arguments", () => {
  test("needs a file and a sane limit and rate", () => {
    expect(parseArgs(["--file", "a.json"]).limit).toBe(300);
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["--file", "a", "--limit", "0"])).toThrow();
    expect(() => parseArgs(["--file", "a", "--usd-inr", "0"])).toThrow();
    expect(() => parseArgs(["--file", "a", "--nope"])).toThrow();
  });
});
