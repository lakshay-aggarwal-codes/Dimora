// P09-T03: refund calculation. Pure functions, an injected clock, exact
// boundary instants, the listing's own time zone. Every amount is integer
// paise. The numbers here are the promises of CANCELLATION_TERMS.
const {
  refundFor,
  refundForCancellation,
  checkInInstant,
} = require("../../src/services/refunds");
const { POLICIES, RULE_TEXT } = require("../../src/config/cancellation");
const {
  CANCELLATION_TERMS,
  CANCELLATION_POLICY_VALUES,
} = require("../../src/config/constants");
const { parseDateOnly } = require("../../src/utils/dates");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const at = (s) => new Date(s);

// 3 nights at 250000 + cleaning 50000 = 800000 (the "Sea house" of the checkout tests).
function booking(extra = {}) {
  return {
    status: "confirmed",
    checkIn: parseDateOnly("2026-12-10"),
    checkOut: parseDateOnly("2026-12-13"),
    nights: 3,
    createdAt: at("2026-11-01T00:00:00Z"),
    pricingSnapshot: {
      totalMinor: 800000,
      subtotalMinor: 750000,
      avgPerNightMinor: 250000,
      currency: "INR",
    },
    listingSnapshot: {
      timezone: "Asia/Kolkata",
      checkInTime: "14:00",
      cancellationPolicy: "flexible",
    },
    ...extra,
  };
}
const CHECK_IN = at("2026-12-10T08:30:00Z"); // 14:00 in Kolkata
const before = (ms) => new Date(CHECK_IN.getTime() - ms);

describe("checkInInstant", () => {
  test("check-in date at the listing's check-in time on the listing's clock", () => {
    expect(checkInInstant(booking()).toISOString()).toBe(
      "2026-12-10T08:30:00.000Z",
    );
    const ny = booking({
      listingSnapshot: { timezone: "America/New_York", checkInTime: "15:00" },
    });
    expect(checkInInstant(ny).toISOString()).toBe("2026-12-10T20:00:00.000Z");
  });
  test("no or invalid time: the start of the check-in day", () => {
    for (const checkInTime of [undefined, "", "soon", "25:00"]) {
      const r = booking({
        listingSnapshot: { timezone: "Asia/Kolkata", checkInTime },
      });
      expect(checkInInstant(r).toISOString()).toBe("2026-12-09T18:30:00.000Z");
    }
  });
  test("no time zone: the app's default (Asia/Kolkata)", () => {
    expect(
      checkInInstant(
        booking({ listingSnapshot: { checkInTime: "14:00" } }),
      ).toISOString(),
    ).toBe("2026-12-10T08:30:00.000Z");
  });
});

describe("flexible: free until 24 h before check-in, then the first night is kept", () => {
  const f = (now) => refundFor("flexible", booking(), now);

  test("far ahead: everything back", () => {
    const r = f(at("2026-11-02T00:00:00Z"));
    expect(r).toEqual(
      expect.objectContaining({
        rule: "flexible_free",
        refundMinor: 800000,
        retainedMinor: 0,
        totalMinor: 800000,
      }),
    );
  });
  test("exactly 24 h before check-in is still free; one second later is not", () => {
    expect(f(before(24 * HOUR)).refundMinor).toBe(800000);
    expect(f(before(24 * HOUR)).rule).toBe("flexible_free");
    const late = f(before(24 * HOUR - 1000));
    expect(late.rule).toBe("flexible_late");
    expect(late.refundMinor).toBe(550000); // 800000 - first night 250000
    expect(late.retainedMinor).toBe(250000);
  });
  test("one millisecond before check-in: still the late rule; at check-in: the stay has started", () => {
    expect(f(before(1)).rule).toBe("flexible_late");
    const started = f(CHECK_IN);
    expect(started.rule).toBe("stay_started");
    expect(started.refundMinor).toBe(0);
    expect(f(at("2026-12-11T10:00:00Z")).refundMinor).toBe(0);
  });
  test("reports until when a full refund holds", () => {
    expect(f(at("2026-11-02T00:00:00Z")).fullRefundUntil.toISOString()).toBe(
      before(24 * HOUR).toISOString(),
    );
    expect(f(before(2 * HOUR)).fullRefundUntil).toBeNull();
  });
});

describe("moderate: free until 5 days before check-in, then the first night and half the rest are kept", () => {
  const m = (now, over) => refundFor("moderate", booking(over), now);
  test("5 days before is the last free moment", () => {
    expect(m(before(5 * DAY)).rule).toBe("moderate_free");
    expect(m(before(5 * DAY)).refundMinor).toBe(800000);
    const late = m(before(5 * DAY - 1000));
    expect(late.rule).toBe("moderate_late");
    // kept: 250000 + half of the other nights (500000) = 500000
    expect(late.retainedMinor).toBe(500000);
    expect(late.refundMinor).toBe(300000);
  });
  test("a part-paise goes to the host (the kept half is rounded up)", () => {
    const odd = {
      pricingSnapshot: {
        totalMinor: 100001,
        subtotalMinor: 100001,
        avgPerNightMinor: 33334,
        currency: "INR",
      },
      nights: 3,
    };
    const r = m(before(DAY), odd);
    // rest = 66667; half rounded up = 33334; kept = 33334 + 33334
    expect(r.retainedMinor).toBe(66668);
    expect(r.refundMinor).toBe(33333);
    expect(r.refundMinor + r.retainedMinor).toBe(100001);
  });
  test("a one-night stay has nothing 'remaining': only the night is kept", () => {
    const one = {
      nights: 1,
      pricingSnapshot: {
        totalMinor: 300000,
        subtotalMinor: 250000,
        avgPerNightMinor: 250000,
        currency: "INR",
      },
    };
    const r = m(before(DAY), one);
    expect(r.retainedMinor).toBe(250000);
    expect(r.refundMinor).toBe(50000);
  });
});

describe("strict: free within 48 h of booking if check-in is 14+ days away; half back until 7 days before; then nothing", () => {
  const s = (now, over) => refundFor("strict", booking(over), now);
  const booked = at("2026-11-01T00:00:00Z");

  test("48 h after booking is the last free moment (with check-in 14+ days away)", () => {
    expect(s(at("2026-11-03T00:00:00Z")).rule).toBe("strict_grace");
    expect(s(at("2026-11-03T00:00:00Z")).refundMinor).toBe(800000);
    const after = s(at("2026-11-03T00:00:01Z"));
    expect(after.rule).toBe("strict_half");
    expect(after.refundMinor).toBe(400000);
  });
  test("check-in must be at least 14 days away at the moment of cancelling", () => {
    const booking2 = { createdAt: before(15 * DAY) };
    expect(s(before(14 * DAY), booking2).rule).toBe("strict_grace");
    expect(s(before(14 * DAY - 1000), booking2).rule).toBe("strict_half");
  });
  test("a booking made close to the stay never gets the grace period", () => {
    const lastMinute = { createdAt: before(5 * DAY) };
    expect(s(before(5 * DAY - 1 * HOUR), lastMinute).rule).toBe("strict_none");
  });
  test("half is rounded down; 7 days before is the last half-refund moment", () => {
    const odd = {
      createdAt: before(30 * DAY),
      pricingSnapshot: { totalMinor: 100001, currency: "INR" },
    };
    const r = s(before(7 * DAY), odd);
    expect(r.rule).toBe("strict_half");
    expect(r.refundMinor).toBe(50000);
    expect(r.retainedMinor).toBe(50001);
    const none = s(before(7 * DAY - 1000), odd);
    expect(none.rule).toBe("strict_none");
    expect(none.refundMinor).toBe(0);
    expect(none.retainedMinor).toBe(100001);
  });
  test("the grace period is reported as the earlier of its two limits", () => {
    const r = s(booked);
    expect(r.fullRefundUntil.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    // booked 10 days before check-in: no grace period at all
    const lateBooker = s(at("2026-11-30T00:00:00Z"), {
      createdAt: at("2026-11-30T00:00:00Z"),
    });
    expect(lateBooker.rule).toBe("strict_half");
    expect(lateBooker.fullRefundUntil).toBeNull();
    // booked exactly 14 days before check-in: grace until 48 h later
    const edge = s(before(14 * DAY), { createdAt: before(14 * DAY) });
    expect(edge.rule).toBe("strict_grace");
    expect(edge.fullRefundUntil.toISOString()).toBe(
      before(14 * DAY).toISOString(),
    );
  });
  test("without a booking time there is no grace period (never guessed)", () => {
    const r = s(booked, { createdAt: undefined });
    expect(r.rule).toBe("strict_half");
  });
  test("the booking time falls back to the first status history entry", () => {
    const r = s(at("2026-11-02T00:00:00Z"), {
      createdAt: undefined,
      statusHistory: [{ to: "pending", at: booked }],
    });
    expect(r.rule).toBe("strict_grace");
  });
});

describe("the listing's own time zone decides the cut-off", () => {
  test("the same 24 h cut-off falls at different instants in Kolkata and New York", () => {
    const kolkata = booking();
    const newYork = booking({
      listingSnapshot: {
        timezone: "America/New_York",
        checkInTime: "14:00",
        cancellationPolicy: "flexible",
      },
    });
    const cutKolkata = checkInInstant(kolkata).getTime() - DAY; // 2026-12-09T08:30Z
    const cutNewYork = checkInInstant(newYork).getTime() - DAY; // 2026-12-09T19:00Z
    expect(cutNewYork - cutKolkata).toBe(10.5 * HOUR);
    // 12:00Z on 9 Dec is after Kolkata's cut-off but before New York's
    const now = at("2026-12-09T12:00:00Z");
    expect(refundFor("flexible", kolkata, now).rule).toBe("flexible_late");
    expect(refundFor("flexible", newYork, now).rule).toBe("flexible_free");
  });
  test("across a daylight-saving change the cut-off is still 24 wall-clock hours (not 24 elapsed) before check-in", () => {
    // check-in Sun 2026-03-08 14:00 New York (EDT, UTC-4) = 18:00Z; the day before it is only 23 h long
    const r = booking({
      checkIn: parseDateOnly("2026-03-08"),
      checkOut: parseDateOnly("2026-03-10"),
      nights: 2,
      pricingSnapshot: {
        totalMinor: 500000,
        subtotalMinor: 500000,
        avgPerNightMinor: 250000,
        currency: "INR",
      },
      listingSnapshot: {
        timezone: "America/New_York",
        checkInTime: "14:00",
        cancellationPolicy: "flexible",
      },
    });
    const ci = checkInInstant(r);
    expect(ci.toISOString()).toBe("2026-03-08T18:00:00.000Z");
    expect(refundFor("flexible", r, new Date(ci.getTime() - DAY)).rule).toBe(
      "flexible_free",
    );
    expect(
      refundFor("flexible", r, new Date(ci.getTime() - DAY + 1000)).rule,
    ).toBe("flexible_late");
  });
});

describe("any policy", () => {
  test("no policy, or one we do not know, promises nothing", () => {
    for (const policy of [
      undefined,
      null,
      "",
      "lenient",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      const r = refundFor(policy, booking(), at("2026-11-02T00:00:00Z"));
      expect(r.rule).toBe("no_policy");
      expect(r.refundMinor).toBe(0);
      expect(r.retainedMinor).toBe(800000);
    }
  });
  test("once the stay has started nothing is refunded, under every policy", () => {
    for (const policy of CANCELLATION_POLICY_VALUES) {
      expect(refundFor(policy, booking(), CHECK_IN).rule).toBe("stay_started");
      expect(refundFor(policy, booking(), CHECK_IN).refundMinor).toBe(0);
    }
  });
  test("refund + kept = total, and 0 <= refund <= total, at every moment from booking to check-in", () => {
    const r = booking({ createdAt: at("2026-10-01T00:00:00Z") });
    for (const policy of CANCELLATION_POLICY_VALUES) {
      let previous = Infinity;
      for (
        let t = at("2026-10-01T00:00:00Z").getTime();
        t <= CHECK_IN.getTime() + HOUR;
        t += 3 * HOUR
      ) {
        const x = refundFor(policy, r, new Date(t));
        expect(Number.isSafeInteger(x.refundMinor)).toBe(true);
        expect(x.refundMinor).toBeGreaterThanOrEqual(0);
        expect(x.refundMinor).toBeLessThanOrEqual(x.totalMinor);
        expect(x.refundMinor + x.retainedMinor).toBe(x.totalMinor);
        expect(x.ruleText).toBe(RULE_TEXT[x.rule]);
        // waiting never makes a refund bigger, except that the strict grace
        // period (a window right after booking) is checked at the start
        if (!(
          policy === "strict" && t < at("2026-10-04T00:00:00Z").getTime()
        )) {
          expect(x.refundMinor).toBeLessThanOrEqual(previous);
          previous = x.refundMinor;
        }
      }
    }
  });
  test("a total of zero or a missing price cannot be refunded from", () => {
    expect(
      refundFor(
        "flexible",
        booking({ pricingSnapshot: { totalMinor: 0, currency: "INR" } }),
        before(DAY),
      ).refundMinor,
    ).toBe(0);
    expect(() =>
      refundFor("flexible", booking({ pricingSnapshot: {} }), before(DAY)),
    ).toThrow(TypeError);
    expect(() =>
      refundFor(
        "flexible",
        booking({ pricingSnapshot: { totalMinor: 1.5 } }),
        before(DAY),
      ),
    ).toThrow(TypeError);
    expect(() => refundFor("flexible", booking(), "yesterday")).toThrow(
      TypeError,
    );
    expect(() => refundFor("flexible", booking(), new Date("nope"))).toThrow(
      TypeError,
    );
  });
  test("a missing average falls back to the subtotal split evenly", () => {
    const r = booking({
      pricingSnapshot: {
        totalMinor: 800000,
        subtotalMinor: 750000,
        currency: "INR",
      },
    });
    expect(refundFor("flexible", r, before(HOUR)).retainedMinor).toBe(250000);
  });
});

describe("refundForCancellation: who cancels", () => {
  const now = before(HOUR); // too late for any guest refund under flexible
  test("the host: always everything, whatever the policy and the date", () => {
    for (const policy of [
      ...CANCELLATION_POLICY_VALUES,
      undefined,
      "lenient",
    ]) {
      for (const when of [now, CHECK_IN, at("2026-12-11T00:00:00Z")]) {
        const r = refundForCancellation({
          reservation: booking({
            listingSnapshot: {
              timezone: "Asia/Kolkata",
              checkInTime: "14:00",
              cancellationPolicy: policy,
            },
          }),
          actor: "host",
          now: when,
        });
        expect(r.refundMinor).toBe(800000);
        expect(r.retainedMinor).toBe(0);
        expect(r.rule).toBe("host_cancelled");
      }
    }
  });
  test("the guest of an unanswered request: everything, even under the strictest policy", () => {
    const r = refundForCancellation({
      reservation: booking({
        status: "pending",
        listingSnapshot: {
          timezone: "Asia/Kolkata",
          checkInTime: "14:00",
          cancellationPolicy: "strict",
        },
      }),
      actor: "guest",
      now,
    });
    expect(r.rule).toBe("request_withdrawn");
    expect(r.refundMinor).toBe(800000);
  });
  test("the guest of a confirmed booking: the policy", () => {
    const r = refundForCancellation({
      reservation: booking(),
      actor: "guest",
      now,
    });
    expect(r.rule).toBe("flexible_late");
    expect(r.refundMinor).toBe(550000);
  });
  test("nobody else", () => {
    expect(() =>
      refundForCancellation({ reservation: booking(), actor: "system", now }),
    ).toThrow(TypeError);
    expect(() =>
      refundForCancellation({ reservation: booking(), actor: undefined, now }),
    ).toThrow(TypeError);
  });
});

describe("the data and the sentences guests read agree", () => {
  test("every policy a host can choose has rules and a sentence, and nothing else does", () => {
    expect(Object.keys(POLICIES).sort()).toEqual(
      [...CANCELLATION_POLICY_VALUES].sort(),
    );
    expect(Object.keys(CANCELLATION_TERMS).sort()).toEqual(
      [...CANCELLATION_POLICY_VALUES].sort(),
    );
  });
  test("every rule has its short text", () => {
    for (const rules of Object.values(POLICIES))
      for (const rule of rules) expect(RULE_TEXT[rule.id]).toBeTruthy();
    for (const id of [
      "host_cancelled",
      "request_withdrawn",
      "stay_started",
      "no_policy",
    ])
      expect(RULE_TEXT[id]).toBeTruthy();
  });
  test("the thresholds in the sentences are the thresholds in the data", () => {
    expect(CANCELLATION_TERMS.flexible).toMatch(
      /until 24 hours before check-in/,
    );
    expect(POLICIES.flexible[0].when.freeUntilHoursBeforeCheckIn).toBe(24);
    expect(CANCELLATION_TERMS.moderate).toMatch(/until 5 days before check-in/);
    expect(POLICIES.moderate[0].when.freeUntilHoursBeforeCheckIn).toBe(5 * 24);
    expect(CANCELLATION_TERMS.strict).toMatch(/within 48 hours of booking/);
    expect(CANCELLATION_TERMS.strict).toMatch(/at least 14 days away/);
    expect(CANCELLATION_TERMS.strict).toMatch(/until 7 days before check-in/);
    expect(POLICIES.strict[0].when).toEqual({
      withinHoursOfBooking: 48,
      minHoursBeforeCheckIn: 14 * 24,
    });
    expect(POLICIES.strict[1].when.freeUntilHoursBeforeCheckIn).toBe(7 * 24);
    expect(POLICIES.strict[1].keep.share).toBe(0.5);
    expect(POLICIES.moderate[1].keep.restShare).toBe(0.5);
  });
  test("every sentence also says the three general rules", () => {
    for (const text of Object.values(CANCELLATION_TERMS)) {
      expect(text).toMatch(/Once the stay has started, nothing is refunded/);
      expect(text).toMatch(/not answered yet can always be cancelled for free/);
      expect(text).toMatch(/if the host cancels, you get everything back/);
    }
  });
});
