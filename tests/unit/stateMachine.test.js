// P07-T05: every legal and illegal reservation transition, exhaustively.
const sm = require("../../src/services/stateMachine");
const { InvalidTransitionError } = require("../../src/utils/errors");

const LEGAL = [
  // paid (simulated, P16-T01): the guest's payment moves it on; the sweeper ends it
  ["awaiting_payment", "confirmed", "guest"],
  ["awaiting_payment", "pending", "guest"],
  ["awaiting_payment", "expired", "system"],
  ["pending", "confirmed", "host"],
  ["pending", "declined", "host"],
  ["pending", "expired", "system"],
  ["pending", "cancelled_by_guest", "guest"],
  ["confirmed", "cancelled_by_guest", "guest"],
  ["confirmed", "cancelled_by_host", "host"],
  ["confirmed", "completed", "system"],
];

describe("transition table", () => {
  test("has exactly the eight statuses of the design (the seven of P07-T05 and awaiting_payment of P16-T01)", () => {
    expect([...sm.STATUSES].sort()).toEqual(
      [
        "awaiting_payment",
        "cancelled_by_guest",
        "cancelled_by_host",
        "completed",
        "confirmed",
        "declined",
        "expired",
        "pending",
      ],
    );
  });

  test("all 64 from/to pairs: only the ten legal ones pass", () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}>${t}`));
    let passed = 0;
    for (const from of sm.STATUSES) {
      for (const to of sm.STATUSES) {
        const expected = legal.has(`${from}>${to}`);
        expect(sm.canTransition(from, to)).toBe(expected);
        if (expected) passed += 1;
        else expect(() => sm.assertTransition(from, to)).toThrow(InvalidTransitionError);
      }
    }
    expect(passed).toBe(10);
  });

  test("each legal move allows only its actor", () => {
    for (const [from, to, actor] of LEGAL) {
      expect(sm.actorsFor(from, to)).toEqual([actor]);
      expect(() => sm.assertTransition(from, to, actor)).not.toThrow();
      for (const other of sm.ACTORS.filter((a) => a !== actor)) {
        expect(() => sm.assertTransition(from, to, other)).toThrow(InvalidTransitionError);
      }
    }
  });

  test("unknown statuses and actors are refused", () => {
    expect(sm.canTransition("pending", "nonsense")).toBe(false);
    expect(sm.canTransition("nonsense", "confirmed")).toBe(false);
    expect(sm.actorsFor("declined", "confirmed")).toEqual([]);
    expect(() => sm.assertTransition("pending", "confirmed", "admin")).toThrow(InvalidTransitionError);
  });

  test("the error is a 409 that names both statuses", () => {
    try {
      sm.assertTransition("declined", "confirmed");
    } catch (err) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("invalid_transition");
      expect(err.from).toBe("declined");
      expect(err.to).toBe("confirmed");
      return;
    }
    throw new Error("did not throw");
  });
});

describe("what a status means for the ledger", () => {
  test("terminal statuses", () => {
    for (const s of ["declined", "expired", "cancelled_by_guest", "cancelled_by_host", "completed"]) {
      expect(sm.isTerminal(s)).toBe(true);
    }
    expect(sm.isTerminal("pending")).toBe(false);
    expect(sm.isTerminal("confirmed")).toBe(false);
    expect(sm.isTerminal("awaiting_payment")).toBe(false);
  });

  test("awaiting_payment, pending, confirmed and completed hold nights; the rest do not", () => {
    expect(sm.STATUSES.filter(sm.holdsNights).sort()).toEqual([
      "awaiting_payment",
      "completed",
      "confirmed",
      "pending",
    ]);
  });

  test("an unpaid booking can only be paid by the guest or ended by the system; the host and an admin cannot move it", () => {
    for (const to of ["confirmed", "pending"]) {
      expect(sm.actorsFor("awaiting_payment", to)).toEqual(["guest"]);
    }
    expect(sm.actorsFor("awaiting_payment", "expired")).toEqual(["system"]);
    for (const to of ["declined", "cancelled_by_guest", "cancelled_by_host", "completed"]) {
      expect(sm.canTransition("awaiting_payment", to)).toBe(false);
    }
    // nothing leads back into awaiting_payment: it is only a starting state
    for (const from of sm.STATUSES) expect(sm.canTransition(from, "awaiting_payment")).toBe(false);
  });

  test("moving into declined, expired or a cancellation releases the nights", () => {
    expect(sm.STATUSES.filter(sm.releasesNights).sort()).toEqual(
      ["cancelled_by_guest", "cancelled_by_host", "declined", "expired"],
    );
  });

  test("a status holds nights exactly when it is not a releasing one", () => {
    for (const s of sm.STATUSES) expect(sm.holdsNights(s)).toBe(!sm.releasesNights(s));
  });
});
