// P08-T01: integer money arithmetic (no database, no floats).
const {
  assertMinor,
  percentOf,
  divideRound,
  mulDivRound,
  multiplyMinor,
  sumMinor,
  MAX_BPS,
} = require("../../src/utils/money");

const MAX = Number.MAX_SAFE_INTEGER;

describe("assertMinor", () => {
  test("accepts zero and positive safe integers and returns the value", () => {
    expect(assertMinor(0)).toBe(0);
    expect(assertMinor(250000, "price")).toBe(250000);
    expect(assertMinor(MAX)).toBe(MAX);
  });

  test("refuses everything else, naming the argument", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, MAX + 1, "5", null, undefined, {}, [], true, 10n]) {
      expect(() => assertMinor(bad, "price")).toThrow(TypeError);
    }
    expect(() => assertMinor(-1, "price")).toThrow(/price must be a non-negative integer/);
    expect(() => assertMinor(-1)).toThrow(/amount must be/);
  });
});

describe("percentOf (round half up to the paisa)", () => {
  test("exact results", () => {
    expect(percentOf(250000, 1800)).toBe(45000);
    expect(percentOf(1000000, 1000)).toBe(100000);
    expect(percentOf(0, 1800)).toBe(0);
    expect(percentOf(12345, 0)).toBe(0);
    expect(percentOf(12345, MAX_BPS)).toBe(12345);
  });

  test("the rounding rule: 0.5 paisa and up goes up, below goes down", () => {
    expect(percentOf(1, 5000)).toBe(1); // 0.5 -> 1
    expect(percentOf(1, 4999)).toBe(0); // 0.4999 -> 0
    expect(percentOf(3, 5000)).toBe(2); // 1.5 -> 2
    expect(percentOf(5, 1000)).toBe(1); // 0.5 -> 1
    expect(percentOf(4, 1000)).toBe(0); // 0.4 -> 0
    expect(percentOf(999, 1800)).toBe(180); // 179.82 -> 180
    expect(percentOf(1, 1)).toBe(0); // 0.0001 -> 0
    expect(percentOf(9999, 1)).toBe(1); // 0.9999 -> 1
  });

  test("a basis point is 1/100 of a percent: 250 bps is 2.5 %", () => {
    expect(percentOf(10000, 250)).toBe(250);
    expect(percentOf(399, 250)).toBe(10); // 9.975 -> 10
  });

  test("exact for products far beyond 2^53 (BigInt inside)", () => {
    expect(percentOf(MAX, MAX_BPS)).toBe(MAX);
    expect(percentOf(MAX, 5000)).toBe(4503599627370496); // 4503599627370495.5 -> up
    expect(percentOf(MAX, 1)).toBe(900719925474); // 900719925474.0991 -> down
  });

  test("never a float", () => {
    for (let amount = 0; amount < 400; amount += 7) {
      for (const bps of [1, 99, 250, 1000, 1800, 9999]) {
        expect(Number.isInteger(percentOf(amount, bps))).toBe(true);
      }
    }
  });

  test("bad arguments throw TypeError", () => {
    for (const bps of [-1, 10001, 1.5, NaN, "1800", null, undefined]) {
      expect(() => percentOf(100, bps)).toThrow(/basisPoints/);
    }
    for (const amount of [-1, 1.5, "100", undefined]) {
      expect(() => percentOf(amount, 100)).toThrow(TypeError);
    }
  });
});

describe("divideRound / mulDivRound", () => {
  test("division rounds half up", () => {
    expect(divideRound(10, 4)).toBe(3); // 2.5
    expect(divideRound(9, 4)).toBe(2); // 2.25
    expect(divideRound(11, 4)).toBe(3); // 2.75
    expect(divideRound(7, 7)).toBe(1);
    expect(divideRound(0, 5)).toBe(0);
    expect(divideRound(1, 2)).toBe(1); // 0.5
  });

  test("mulDivRound is amount x numerator / denominator, half up, exactly", () => {
    expect(mulDivRound(100, 1, 3)).toBe(33);
    expect(mulDivRound(100, 2, 3)).toBe(67);
    expect(mulDivRound(MAX, MAX, MAX)).toBe(MAX);
  });

  test("a zero or bad divisor, and bad amounts, throw", () => {
    for (const d of [0, -1, 1.5, "2", undefined, NaN]) {
      expect(() => divideRound(10, d)).toThrow(/denominator/);
    }
    expect(() => divideRound(-1, 2)).toThrow(TypeError);
    expect(() => mulDivRound(1, -1, 2)).toThrow(TypeError);
  });

  test("a result that does not fit a safe integer is a RangeError", () => {
    expect(() => mulDivRound(MAX, MAX, 1)).toThrow(RangeError);
  });
});

describe("multiplyMinor / sumMinor", () => {
  test("multiply by a whole count", () => {
    expect(multiplyMinor(250000, 90)).toBe(22500000);
    expect(multiplyMinor(250000, 0)).toBe(0);
    expect(multiplyMinor(0, 5)).toBe(0);
  });

  test("overflow and non-integers are refused", () => {
    expect(() => multiplyMinor(MAX, 2)).toThrow(RangeError);
    expect(() => multiplyMinor(1.5, 2)).toThrow(TypeError);
    expect(() => multiplyMinor(10, 0.5)).toThrow(TypeError);
    expect(() => multiplyMinor(10, -1)).toThrow(TypeError);
  });

  test("sum of a list, empty is 0, overflow and junk are refused", () => {
    expect(sumMinor([1, 2, 3])).toBe(6);
    expect(sumMinor([])).toBe(0);
    expect(sumMinor([MAX])).toBe(MAX);
    expect(() => sumMinor([MAX, 1])).toThrow(RangeError);
    expect(() => sumMinor([1, 1.5])).toThrow(TypeError);
    expect(() => sumMinor([1, -1])).toThrow(TypeError);
    expect(() => sumMinor("12")).toThrow(/array/);
    expect(() => sumMinor(undefined)).toThrow(TypeError);
  });
});
