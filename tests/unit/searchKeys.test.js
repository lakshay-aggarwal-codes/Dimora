// P05-T01: the normalised place keys (no database).
const {
  normaliseToken,
  locationKeys,
  keysForListing,
  destinationParts,
  escapeRegex,
  MAX_PARTS,
} = require("../../src/utils/searchKeys");

describe("normaliseToken", () => {
  test("lower-case, no accents, single spaces, no punctuation (hyphens too)", () => {
    expect(normaliseToken("  São   Paulo! ")).toBe("sao paulo");
    expect(normaliseToken("ZÜRICH")).toBe("zurich");
    expect(normaliseToken("St. John's")).toBe("st john s");
    expect(normaliseToken("Jaipur-Rural")).toBe("jaipur rural");
    // Other scripts keep their vowel signs (they are combining marks, not letters).
    for (const word of ["पुणे", "मुंबई", "கோவை"]) {
      const key = normaliseToken(word);
      expect(key).toBe(word.normalize("NFKD"));
      expect(key.includes(" ")).toBe(false);
    }
    expect(normaliseToken("नई  दिल्ली")).toBe("नई दिल्ली".normalize("NFKD"));
  });

  test("anything that is not a string, and blanks, give an empty string", () => {
    for (const bad of [undefined, null, 5, {}, [], "", "   ", "!!!"]) {
      expect(normaliseToken(bad)).toBe("");
    }
  });

  test("is capped at 100 characters", () => {
    expect(normaliseToken("a".repeat(500))).toHaveLength(100);
  });

  test("does the same thing twice (idempotent)", () => {
    const once = normaliseToken("São  Paulo, Brasil");
    expect(normaliseToken(once)).toBe(once);
  });
});

describe("locationKeys", () => {
  test("city, state and country keys, and a stable pipe-joined locationKey", () => {
    expect(locationKeys({ city: "Panaji", state: "Goa", country: "India" })).toEqual({
      cityKey: "panaji",
      stateKey: "goa",
      countryKey: "india",
      locationKey: "panaji|goa|india",
    });
  });

  test("empty parts are left out of locationKey", () => {
    expect(locationKeys({ city: "Manali", country: "India" }).locationKey).toBe("manali|india");
    expect(locationKeys({}).locationKey).toBe("");
    expect(locationKeys().locationKey).toBe("");
  });
});

describe("keysForListing", () => {
  test("uses the structured address", () => {
    expect(
      keysForListing({ address: { city: "Panaji", state: "Goa", country: "India" } }).locationKey,
    ).toBe("panaji|goa|india");
  });

  test("falls back to the old free-text location and country", () => {
    expect(keysForListing({ location: "Manali", country: "India" })).toMatchObject({
      cityKey: "manali",
      countryKey: "india",
    });
  });

  test('"Malibu, California" in one field becomes city and state', () => {
    expect(
      keysForListing({ address: { city: "Malibu, California" }, country: "United States" }),
    ).toMatchObject({ cityKey: "malibu", stateKey: "california", countryKey: "united states" });
    // an explicit state wins over the second part
    expect(
      keysForListing({ address: { city: "Malibu, CA", state: "California" } }).stateKey,
    ).toBe("california");
  });

  test("the address country wins over the old country text; nothing at all is fine", () => {
    expect(
      keysForListing({ address: { country: "India" }, country: "Bharat" }).countryKey,
    ).toBe("india");
    expect(keysForListing(null).locationKey).toBe("");
    expect(keysForListing({}).locationKey).toBe("");
  });

  test("reads a Mongoose-style document through get()", () => {
    const values = { "address.city": "Panaji", "address.state": "Goa", "address.country": "India" };
    const doc = { get: (path) => values[path], address: {} };
    expect(keysForListing(doc).locationKey).toBe("panaji|goa|india");
  });
});

describe("destinationParts", () => {
  test("comma-separated parts, normalised, empty ones dropped", () => {
    expect(destinationParts("Panaji, Goa , ,India")).toEqual(["panaji", "goa", "india"]);
    expect(destinationParts("  ")).toEqual([]);
  });

  test("at most three parts, each at most 60 characters; non-strings give nothing", () => {
    expect(destinationParts("a,b,c,d,e")).toHaveLength(MAX_PARTS);
    expect(destinationParts("x".repeat(200))[0]).toHaveLength(60);
    for (const bad of [undefined, null, 5, {}, ["a"]]) expect(destinationParts(bad)).toEqual([]);
  });

  test("regular-expression characters are removed before they can matter", () => {
    expect(destinationParts(".*")).toEqual([]);
    expect(destinationParts("(a|b)+")).toEqual(["a b"]);
  });
});

test("escapeRegex neutralises every special character", () => {
  const text = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o/p-q";
  const re = new RegExp(`^${escapeRegex(text)}$`);
  expect(re.test(text)).toBe(true);
  expect(re.test("aXb*c+d?e^f$g{h}i(j)k|l[m]n\\o/p-q")).toBe(false);
});
