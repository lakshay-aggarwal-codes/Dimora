// P05-T04: the optional "Setting" (vibe) of a listing in the wizard's basics step.
const { validateStep } = require("../../src/validation/wizard");
const { VIBES, VIBE_VALUES } = require("../../src/config/constants");

const basics = (extra = {}) => ({
  title: "Sunny flat by the sea",
  description: "A bright two-room flat a minute from the beach.",
  propertyType: "apartment",
  roomType: "entire_place",
  ...extra,
});

describe("vibe in the basics step", () => {
  test("it is optional: the step is valid without it", () => {
    const { errors, value } = validateStep(1, basics());
    expect(errors).toEqual({});
    expect(value.vibe).toBeUndefined();
  });

  test.each(VIBE_VALUES)("%s is accepted", (vibe) => {
    const { errors, value } = validateStep(1, basics({ vibe }));
    expect(errors).toEqual({});
    expect(value.vibe).toBe(vibe);
  });

  test("an empty choice is accepted (it clears the setting)", () => {
    const { errors, value } = validateStep(1, basics({ vibe: "" }));
    expect(errors).toEqual({});
    expect(value.vibe).toBe("");
  });

  test("a value that is not in the list is refused with a plain message", () => {
    const { errors } = validateStep(1, basics({ vibe: "moon" }));
    expect(errors.vibe).toBe("Choose a setting from the list.");
  });

  test("the list has the six settings the category strip uses", () => {
    expect(VIBES.map((item) => item.value)).toEqual(["beach", "mountain", "lake", "desert", "countryside", "city"]);
    for (const item of VIBES) expect(item.label).toBeTruthy();
  });
});
