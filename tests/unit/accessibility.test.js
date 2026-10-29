// P15-T05: accessibility features declared by the host. Pure parts: the list,
// the wizard step, the search parameter, the filter, chips, suggestions, and the
// panels rendered on their own.
const path = require("node:path");
const ejs = require("ejs");
const mongoose = require("mongoose");
const {
  AMENITIES,
  ACCESSIBILITY_FEATURES,
  ACCESSIBILITY_VALUES,
  ACCESSIBILITY_NOTICE,
} = require("../../src/config/constants");
const { accessibilityLabels } = require("../../src/utils/accessibility");
const { validateStep } = require("../../src/validation/wizard");
const { parseSearchParams } = require("../../src/validation/search");
const { buildFilter } = require("../../src/services/search");
const { parseListingQuery } = require("../../src/validation/searchQuery");
const {
  activeChips,
  filterCount,
  resetFiltersHref,
  PANEL_FIELDS,
} = require("../../src/utils/filterChips");
const { listingsUrl, hiddenFields } = require("../../src/utils/searchUrl");
const Listing = require("../../src/models/listing");

const ROOT = path.join(__dirname, "..", "..");
const STEP3 = { guests: 2, bedrooms: 1, beds: 1, bathrooms: 1 };

describe("the list", () => {
  test("six features, unique keys, plain labels, none is an amenity key", () => {
    expect(ACCESSIBILITY_FEATURES.map((f) => f.value)).toEqual([
      "step_free_entrance",
      "step_free_bathroom",
      "elevator",
      "wide_doorway",
      "grab_rails",
      "accessible_parking",
    ]);
    expect(new Set(ACCESSIBILITY_VALUES).size).toBe(6);
    const amenityKeys = AMENITIES.map((a) => a.value);
    expect(ACCESSIBILITY_VALUES.filter((v) => amenityKeys.includes(v))).toEqual(
      [],
    );
    for (const f of ACCESSIBILITY_FEATURES)
      expect(f.label).toMatch(/^[A-Z][^<>&]+$/);
  });

  test("the notice says the host declares and nobody checked, and claims no verification", () => {
    expect(ACCESSIBILITY_NOTICE).toMatch(/Declared by the host/);
    expect(ACCESSIBILITY_NOTICE).toMatch(/has not checked/);
    expect(ACCESSIBILITY_NOTICE).not.toMatch(
      /verified by|certified|guaranteed/i,
    );
  });

  test("accessibilityLabels: fixed order, known keys only, once each", () => {
    expect(
      accessibilityLabels([
        "elevator",
        "step_free_entrance",
        "elevator",
        "<b>x</b>",
        5,
        null,
      ]),
    ).toEqual(["Step-free entrance", "Elevator"]);
    expect(accessibilityLabels(undefined)).toEqual([]);
    expect(accessibilityLabels("elevator")).toEqual([]);
  });
});

describe("the wizard's rooms step", () => {
  test("is optional: no feature ticked gives an empty list", () => {
    const { value, errors } = validateStep(3, STEP3);
    expect(errors).toEqual({});
    expect(value.accessibility).toEqual([]);
  });

  test("one box (a string) and several boxes (an array) are both accepted", () => {
    expect(
      validateStep(3, { ...STEP3, accessibility: "elevator" }).value
        .accessibility,
    ).toEqual(["elevator"]);
    expect(
      validateStep(3, { ...STEP3, accessibility: ["grab_rails", "elevator"] })
        .value.accessibility,
    ).toEqual(["grab_rails", "elevator"]);
  });

  test("a value outside the list or a repeat is refused with a plain message", () => {
    expect(
      validateStep(3, { ...STEP3, accessibility: ["jacuzzi"] }).errors
        .accessibility,
    ).toBe("Choose accessibility features from the list.");
    expect(
      validateStep(3, { ...STEP3, accessibility: ["elevator", "elevator"] })
        .errors.accessibility,
    ).toBe("Each accessibility feature can be chosen once.");
    expect(
      validateStep(3, { ...STEP3, accessibility: [{ $ne: 1 }] }).errors
        .accessibility,
    ).toBeTruthy();
  });

  test("the amenities rule is untouched", () => {
    expect(
      validateStep(3, { ...STEP3, amenities: ["wifi"] }).value.amenities,
    ).toEqual(["wifi"]);
    expect(
      validateStep(3, { ...STEP3, amenities: ["elevator"] }).errors.amenities,
    ).toBeTruthy();
  });
});

describe("the model", () => {
  test("accessibility is a list of strings that starts empty", () => {
    expect(Listing.schema.path("accessibility")).toBeDefined();
    const doc = new Listing({});
    expect([...doc.accessibility]).toEqual([]);
    doc.accessibility = ["elevator"];
    expect([...doc.accessibility]).toEqual(["elevator"]);
  });
  test("is not mixed up with amenities", () => {
    const doc = new Listing({
      amenities: ["wifi"],
      accessibility: ["elevator"],
    });
    expect([...doc.amenities]).toEqual(["wifi"]);
    expect([...doc.accessibility]).toEqual(["elevator"]);
    expect(mongoose.isValidObjectId(doc._id)).toBe(true);
  });
});

describe("the search parameter `access`", () => {
  test("a list of known features is accepted, one value or many", () => {
    expect(parseSearchParams({ access: "elevator" }).value.access).toEqual([
      "elevator",
    ]);
    expect(
      parseSearchParams({ access: ["elevator", "grab_rails"] }).value.access,
    ).toEqual(["elevator", "grab_rails"]);
  });

  test("an unknown value, an object or a repeat is refused and never reaches the filter", () => {
    for (const bad of [
      ["jacuzzi"],
      { $ne: "x" },
      [{ $gt: "" }],
      ["elevator", "elevator"],
    ]) {
      const { value, errors } = parseSearchParams({ access: bad });
      expect(errors.access).toBeTruthy();
      expect(value.access).toBeUndefined();
      expect(buildFilter(value)).not.toHaveProperty("accessibility");
    }
  });

  test("the filter needs ALL the features, and says nothing when none are asked for", () => {
    expect(
      buildFilter({ access: ["elevator", "grab_rails"] }).accessibility,
    ).toEqual({
      $all: ["elevator", "grab_rails"],
    });
    expect(buildFilter({})).not.toHaveProperty("accessibility");
    expect(buildFilter({ access: [] })).not.toHaveProperty("accessibility");
  });

  test("it narrows and never replaces the other filters", () => {
    const filter = buildFilter({
      access: ["elevator"],
      amenities: ["wifi"],
      instantBook: true,
    });
    expect(filter.accessibility).toEqual({ $all: ["elevator"] });
    expect(filter.amenities).toEqual({ $all: ["wifi"] });
    expect(filter.instantBook).toBe(true);
    expect(filter.status).toBeDefined();
  });
});

describe("the URL state", () => {
  const NOW = new Date("2026-10-29T06:00:00Z");

  test("`access` and `access[]` are read, and kept in links after the amenities", () => {
    const a = parseListingQuery({ access: ["elevator"] }, { now: NOW });
    expect(a.state.access).toEqual(["elevator"]);
    const b = parseListingQuery({ "access[]": ["grab_rails"] }, { now: NOW });
    expect(b.state.access).toEqual(["grab_rails"]);
    expect(
      listingsUrl({ amenities: ["wifi"], access: ["elevator"], minRating: 4 }),
    ).toBe("/listings?amenities=wifi&access=elevator&minRating=4");
  });

  test("a wrong value is an error message and the rest of the search survives", () => {
    const parsed = parseListingQuery(
      { dest: "Goa", access: ["jacuzzi"] },
      { now: NOW },
    );
    expect(parsed.errors.access).toMatch(
      /not one of the choices|Accessibility/,
    );
    expect(parsed.state.dest).toBe("Goa");
    expect(parsed.state.access).toBeUndefined();
  });

  test("the panel owns `access`; its hidden inputs do not repeat it", () => {
    expect(PANEL_FIELDS).toContain("access");
    const pairs = hiddenFields(
      { dest: "Goa", access: ["elevator"] },
      PANEL_FIELDS,
    );
    expect(pairs).toEqual([["dest", "Goa"]]);
  });
});

describe("chips, count, reset", () => {
  const state = {
    dest: "Goa",
    amenities: ["wifi"],
    access: ["elevator", "grab_rails"],
  };

  test("one chip per feature, worded as declared, removing only that one", () => {
    const chips = activeChips(state);
    const access = chips.filter((c) => c.key.startsWith("access:"));
    expect(access.map((c) => c.label)).toEqual([
      "Elevator (declared)",
      "Grab rails in the bathroom (declared)",
    ]);
    expect(decodeURIComponent(access[0].href)).toBe(
      "/listings?dest=Goa&amenities=wifi&access=grab_rails",
    );
    expect(decodeURIComponent(access[1].href)).toBe(
      "/listings?dest=Goa&amenities=wifi&access=elevator",
    );
  });

  test("they count in the Filters badge, and Reset removes them but keeps the search", () => {
    expect(filterCount(state)).toBe(3);
    expect(resetFiltersHref(state)).toBe("/listings?dest=Goa");
  });
});

describe("the filter panel", () => {
  const lists = {
    ACCESSIBILITY_FEATURES,
    AMENITIES,
    PROPERTY_TYPES: [],
    ROOM_TYPES: [],
  };
  const render = (values, errors = {}) =>
    ejs.renderFile(path.join(ROOT, "views/partials/filter-panel.ejs"), {
      panel: { values, typed: {}, fields: PANEL_FIELDS, lists },
      errors,
      filterState: values,
      filterCount: 0,
      resetHref: "/listings",
      hiddenFields,
    });

  test("has an accessibility group with a box per feature, ticked from the URL, and the host-declared note", async () => {
    const html = await render({ access: ["elevator"] });
    expect(html).toContain("Accessibility (declared by hosts)");
    expect(html).toContain("Hosts declare these. Dimora has not checked them.");
    for (const f of ACCESSIBILITY_FEATURES) {
      expect(html).toContain(
        `name="access" value="${f.value}" id="access-${f.value}"`,
      );
    }
    expect(html).toMatch(/value="elevator" id="access-elevator" checked/);
    expect(html).not.toMatch(
      /value="grab_rails" id="access-grab_rails" checked/,
    );
    expect(html).toContain('aria-describedby="access-note"');
  });

  test("does not send a ticked feature twice (no hidden copy)", async () => {
    const html = await render({ access: ["elevator"], dest: "Goa" });
    expect(html.match(/type="hidden" name="access"/g)).toBeNull();
    expect(html).toContain('<input type="hidden" name="dest" value="Goa">');
  });

  test("a message for a wrong value shows with the group", async () => {
    const html = await render(
      {},
      { access: "Accessibility features is not one of the choices." },
    );
    expect(html).toContain("Accessibility features is not one of the choices.");
  });
});

describe("the host's form", () => {
  const render = (values = {}, errors = {}) =>
    ejs.renderFile(path.join(ROOT, "views/host/fields/details.ejs"), {
      values,
      errors,
      lists: { AMENITIES, ACCESSIBILITY_FEATURES },
    });

  test("one labelled box per feature, ticked from the saved list, and says the guests see it as declared", async () => {
    const html = await render({ accessibility: ["wide_doorway"] });
    expect(html).toContain(
      '<legend class="h5">Accessibility features</legend>',
    );
    expect(html).toMatch(/Declared by the host/);
    expect(html).toMatch(/Dimora does not check them/);
    for (const f of ACCESSIBILITY_FEATURES) {
      expect(html).toContain(
        `for="accessibility-${f.value}">${f.label}</label>`,
      );
    }
    expect(html).toMatch(
      /id="accessibility-wide_doorway" value="wide_doorway" checked/,
    );
    expect(html).not.toMatch(
      /id="accessibility-elevator" value="elevator" checked/,
    );
  });

  test("shows its error and links it to the group", async () => {
    const html = await render(
      {},
      { accessibility: "Choose accessibility features from the list." },
    );
    expect(html).toContain('id="accessibility-error"');
    expect(html).toContain("Choose accessibility features from the list.");
    expect(html).toContain(
      'aria-describedby="accessibility-hint accessibility-error"',
    );
  });

  test("the amenities group is still there", async () => {
    expect(await render({ amenities: ["wifi"] })).toMatch(
      /name="amenities" id="amenity-wifi" value="wifi" checked/,
    );
  });
});
