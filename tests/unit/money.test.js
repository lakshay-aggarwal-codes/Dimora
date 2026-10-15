// P03-T03: formatMoney(minor, currency)
const { formatMoney } = require("../../src/utils/money");

describe("formatMoney", () => {
  test("rupees from paise, Indian digit grouping", () => {
    expect(formatMoney(123456)).toBe("₹1,234.56");
    expect(formatMoney(12345600)).toBe("₹1,23,456");
  });
  test("whole amounts drop the decimals; fractions keep two", () => {
    expect(formatMoney(120000)).toBe("₹1,200");
    expect(formatMoney(120050)).toBe("₹1,200.50");
    expect(formatMoney(1)).toBe("₹0.01");
  });
  test("zero and negative amounts (refunds)", () => {
    expect(formatMoney(0)).toBe("₹0");
    expect(formatMoney(-5000)).toBe("-₹50");
  });
  test("no amount is 'N/A'", () => {
    expect(formatMoney(null)).toBe("N/A");
    expect(formatMoney(undefined)).toBe("N/A");
  });
  test("another currency", () => {
    expect(formatMoney(1050, "USD")).toBe("$10.50");
  });
  test("a currency without minor units is not divided by 100", () => {
    expect(formatMoney(100, "JPY")).toMatch(/100$/);
  });
  test.each([12.5, "1200", NaN, Infinity, 2 ** 60, {}, true])(
    "refuses %p (not an integer amount)",
    (value) => {
      expect(() => formatMoney(value)).toThrow(TypeError);
    },
  );
  test.each(["inr", "RS", "", null, 5])(
    "refuses the currency %p",
    (currency) => {
      expect(() => formatMoney(100, currency)).toThrow(TypeError);
    },
  );
});
