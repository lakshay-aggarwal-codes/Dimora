// P04-T02: the wizard's rules about steps, in memory (no database).
const Listing = require("../../src/models/listing");
const wizard = require("../../src/services/wizard");
const { validateStep } = require("../../src/validation/wizard");

const basicsValue = {
  title: "Sunny flat by the sea",
  description: "A bright two-room flat a minute from the beach.",
  propertyType: "apartment",
  roomType: "entire_place",
};
const locationValue = {
  line1: "12 Beach Road",
  city: "Goa",
  state: "Goa",
  country: "India",
  postalCode: "403001",
};
const POINT = { type: "Point", coordinates: [73.8, 15.5] };
const photo = (n) => ({
  url: `https://res.cloudinary.test/dimora_DEV/p${n}.jpg`,
  publicId: `dimora_DEV/p${n}`,
  alt: "",
  caption: "",
  order: n,
});

function draft() {
  const listing = new Listing({ status: "draft" });
  wizard.applyStep(listing, 1, validateStep(1, basicsValue).value);
  wizard.markStepDone(listing, 1);
  return listing;
}

function finished() {
  const listing = draft();
  wizard.applyStep(listing, 2, locationValue, { geometry: POINT });
  wizard.markStepDone(listing, 2);
  wizard.applyStep(
    listing,
    3,
    validateStep(3, { guests: "4", bedrooms: "2", beds: "2", bathrooms: "1", amenities: ["wifi"] }).value,
  );
  wizard.markStepDone(listing, 3);
  listing.images.push(photo(0));
  wizard.markStepDone(listing, 4);
  wizard.applyStep(
    listing,
    5,
    validateStep(5, {
      price: "2500",
      cleaningFee: "300",
      minNights: "1",
      maxNights: "30",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      cancellationPolicy: "moderate",
    }).value,
  );
  wizard.markStepDone(listing, 5);
  return listing;
}

test("there are six steps in order, and URL step numbers are parsed strictly", () => {
  expect(wizard.STEPS.map((s) => s.key)).toEqual([
    "basics",
    "location",
    "details",
    "photos",
    "pricing",
    "review",
  ]);
  expect(wizard.parseStep("3")).toBe(3);
  for (const bad of ["0", "7", "-1", "1.5", "abc", "", undefined, "1 ", "01"]) {
    expect(wizard.parseStep(bad)).toBeNull();
  }
});

describe("a new draft", () => {
  test("has finished step 1 only; only step 2 can be opened next", () => {
    const listing = draft();
    expect(wizard.isStepComplete(listing, 1)).toBe(true);
    expect(wizard.isStepComplete(listing, 2)).toBe(false);
    expect(wizard.canOpenStep(listing, 1)).toBe(true);
    expect(wizard.canOpenStep(listing, 2)).toBe(true);
    for (const n of [3, 4, 5, 6]) expect(wizard.canOpenStep(listing, n)).toBe(false);
    expect(wizard.firstIncompleteStep(listing)).toBe(2);
  });

  test("steps with default values are NOT finished until saved (capacity and nights have defaults)", () => {
    const listing = draft();
    expect(wizard.isStepComplete(listing, 3)).toBe(false);
    expect(wizard.isStepComplete(listing, 5)).toBe(false);
  });

  test("stepStatuses marks the first unfinished step reachable and everything after it not", () => {
    const rows = wizard.stepStatuses(draft());
    expect(rows.map((r) => [r.n, r.complete, r.reachable])).toEqual([
      [1, true, true],
      [2, false, true],
      [3, false, false],
      [4, false, false],
      [5, false, false],
      [6, false, false],
    ]);
  });
});

describe("applyStep", () => {
  test("step 1 sets the basics", () => {
    const listing = draft();
    expect(listing.title).toBe("Sunny flat by the sea");
    expect(listing.propertyType).toBe("apartment");
    expect(listing.roomType).toBe("entire_place");
  });

  test("step 2 stores the address, shows only city and state in the old text field, and clears needsReview", () => {
    const listing = draft();
    listing.needsReview = true;
    wizard.applyStep(listing, 2, locationValue, { geometry: POINT });
    expect(listing.address.line1).toBe("12 Beach Road");
    expect(listing.location).toBe("Goa, Goa");
    expect(listing.location).not.toMatch(/Beach Road/);
    expect(listing.country).toBe("India");
    expect(listing.needsReview).toBe(false);
    expect(listing.geometry.coordinates).toEqual([73.8, 15.5]);
  });

  test("step 5 converts rupees to paise", () => {
    const listing = finished();
    expect(listing.pricing.nightlyMinor).toBe(250000);
    expect(listing.pricing.cleaningFeeMinor).toBe(30000);
    expect(listing.checkInTime).toBe("14:00");
    expect(listing.cancellationPolicy).toBe("moderate");
  });

  test("steps 4 and 6 have nothing to apply", () => {
    expect(() => wizard.applyStep(draft(), 4, {})).toThrow();
    expect(() => wizard.applyStep(draft(), 6, {})).toThrow();
  });
});

describe("a finished draft", () => {
  test("all steps are finished and everything can be opened", () => {
    const listing = finished();
    for (const n of [1, 2, 3, 4, 5, 6]) expect(wizard.isStepComplete(listing, n)).toBe(true);
    expect(wizard.canOpenStep(listing, 6)).toBe(true);
    expect(wizard.firstIncompleteStep(listing)).toBe(6);
  });

  test("it is a valid published listing too (the model agrees with the wizard)", async () => {
    const listing = finished();
    listing.status = "published";
    await expect(listing.validate()).resolves.toBeUndefined();
  });

  test("removing the last photo makes step 4 (and so the review) unfinished again", () => {
    const listing = finished();
    listing.images.splice(0, listing.images.length);
    expect(wizard.isStepComplete(listing, 4)).toBe(false);
    expect(wizard.isStepComplete(listing, 6)).toBe(false);
    expect(wizard.firstIncompleteStep(listing)).toBe(4);
  });

  test("stored data that stopped being valid unfinishes its step", () => {
    const listing = finished();
    listing.set("pricing.nightlyMinor", 5000); // under the INR 100 floor
    expect(wizard.isStepComplete(listing, 5)).toBe(false);
    expect(wizard.firstIncompleteStep(listing)).toBe(5);
  });

  test("a step with no coordinates is not finished", () => {
    const listing = finished();
    listing.set("geometry.coordinates", []);
    expect(wizard.isStepComplete(listing, 2)).toBe(false);
  });
});

describe("addressChanged / addressQuery", () => {
  test("no look-up when the address is the same, one when anything differs or there is no point", () => {
    const listing = finished();
    expect(wizard.addressChanged(listing, { ...locationValue })).toBe(false);
    expect(wizard.addressChanged(listing, { ...locationValue, line1: "14 Beach Road" })).toBe(true);
    expect(wizard.addressChanged(listing, { ...locationValue, state: "" })).toBe(true);
    listing.set("geometry.coordinates", []);
    expect(wizard.addressChanged(listing, { ...locationValue })).toBe(true);
  });

  test("the geocoder gets the whole address, skipping blanks", () => {
    expect(wizard.addressQuery(locationValue)).toBe("12 Beach Road, Goa, Goa, 403001");
    expect(wizard.addressQuery({ line1: "1 A", city: "B", state: "", postalCode: undefined })).toBe(
      "1 A, B",
    );
  });
});

test("markStepDone keeps the list sorted and without repeats", () => {
  const listing = new Listing({ status: "draft" });
  for (const n of [3, 1, 3, 2]) wizard.markStepDone(listing, n);
  expect([...listing.wizardSteps]).toEqual([1, 2, 3]);
});
