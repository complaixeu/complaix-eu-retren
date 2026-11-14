import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { evaluateEligibility } from "@/features/rules/eligibility";
import { getOperatorConfig } from "@/features/rules/operator-config";
import type { EligibilityInput, OperatorId } from "@/shared/contracts";

const SCHEDULED_ARRIVAL = "2026-11-14T08:00:00.000Z";
const SCHEDULED_DEPARTURE = "2026-11-14T07:00:00.000Z";
const NOW = "2026-12-02T12:00:00.000Z";

function inputFor(
  operator: OperatorId,
  delayMinutes: number,
  overrides: Partial<EligibilityInput> = {},
): EligibilityInput {
  const actualArrival = new Date(
    Date.parse(overrides.scheduledArrival ?? SCHEDULED_ARRIVAL) + delayMinutes * 60_000,
  ).toISOString();

  return {
    operator,
    scheduledDeparture: SCHEDULED_DEPARTURE,
    scheduledArrival: SCHEDULED_ARRIVAL,
    actualArrival,
    now: NOW,
    ...overrides,
  };
}

describe("evaluateEligibility delay tiers", () => {
  it.each([
    {
      name: "Iryo 59 minutes is not eligible",
      operator: "iryo",
      delay: 59,
      status: "not_eligible",
    },
    {
      name: "Iryo 60 minutes is doubtful",
      operator: "iryo",
      delay: 60,
      status: "doubtful",
      percent: 50,
    },
    {
      name: "Iryo 61 minutes is 50%",
      operator: "iryo",
      delay: 61,
      status: "eligible",
      percent: 50,
    },
    {
      name: "Iryo 90 minutes remains 50%",
      operator: "iryo",
      delay: 90,
      status: "eligible",
      percent: 50,
    },
    {
      name: "Iryo 91 minutes is 100%",
      operator: "iryo",
      delay: 91,
      status: "eligible",
      percent: 100,
    },
    {
      name: "Renfe 59 minutes is not eligible",
      operator: "renfe",
      delay: 59,
      status: "not_eligible",
    },
    {
      name: "Renfe 60 minutes is 50%",
      operator: "renfe",
      delay: 60,
      status: "eligible",
      percent: 50,
    },
    {
      name: "Renfe 90 minutes remains 50%",
      operator: "renfe",
      delay: 90,
      status: "eligible",
      percent: 50,
    },
    {
      name: "Renfe 91 minutes is 100%",
      operator: "renfe",
      delay: 91,
      status: "eligible",
      percent: 100,
    },
    {
      name: "Ouigo 29 minutes is not eligible",
      operator: "ouigo",
      delay: 29,
      status: "not_eligible",
    },
    {
      name: "Ouigo 30 minutes starts a 50% non-refundable voucher",
      operator: "ouigo",
      delay: 30,
      status: "eligible",
      percent: 50,
      payment: ["non_refundable_voucher"],
    },
    {
      name: "Ouigo 59 minutes remains a 50% non-refundable voucher",
      operator: "ouigo",
      delay: 59,
      status: "eligible",
      percent: 50,
      payment: ["non_refundable_voucher"],
    },
    {
      name: "Ouigo 60 minutes starts a 50% refundable voucher",
      operator: "ouigo",
      delay: 60,
      status: "eligible",
      percent: 50,
      payment: ["refundable_voucher"],
    },
    {
      name: "Ouigo 89 minutes remains a 50% refundable voucher",
      operator: "ouigo",
      delay: 89,
      status: "eligible",
      percent: 50,
      payment: ["refundable_voucher"],
    },
    {
      name: "Ouigo 90 minutes starts a 100% refundable voucher",
      operator: "ouigo",
      delay: 90,
      status: "eligible",
      percent: 100,
      payment: ["refundable_voucher"],
    },
  ] as const)("$name", ({ operator, delay, status, percent, payment }) => {
    const result = evaluateEligibility(inputFor(operator, delay));

    expect(result.status).toBe(status);
    expect(result.tier?.percent).toBe(percent);
    if (payment) expect(result.tier?.payment).toEqual(payment);
  });

  it("keeps Iryo vouchers first and only offers money on an explicit request", () => {
    const result = evaluateEligibility(inputFor("iryo", 61));
    const config = getOperatorConfig("iryo", "2026-11-13");

    expect(result.tier?.payment).toEqual(["voucher", "money"]);
    expect(config.payment.default).toEqual(["voucher"]);
    expect(config.payment.onMoneyRequest).toEqual(["money"]);
  });

  it.each([
    { name: "purchase through an intermediary", overrides: { purchaseChannel: "intermediary" } },
    { name: "purchase at Casa Iryo", overrides: { purchasedAtCasaIryo: true } },
  ] as const)("limits Iryo $name compensation to vouchers", ({ overrides }) => {
    const result = evaluateEligibility(inputFor("iryo", 61, overrides));

    expect(result.status).toBe("eligible");
    expect(result.tier?.payment).toEqual(["voucher"]);
  });
});

describe("evaluateEligibility Adif speed-limit exclusion", () => {
  it("excludes a Renfe ticket bought on 2026-01-31", () => {
    const result = evaluateEligibility(inputFor("renfe", 60, { purchaseDate: "2026-01-31" }));

    expect(result.status).toBe("not_eligible");
    expect(result.reason).toMatch(/Adif/i);
  });

  it("allows a Renfe ticket bought before 2026-01-31", () => {
    const result = evaluateEligibility(inputFor("renfe", 60, { purchaseDate: "2026-01-30" }));

    expect(result.status).toBe("eligible");
    expect(result.tier?.percent).toBe(50);
  });

  it("does not apply the Renfe Adif rule when purchase date is unknown", () => {
    const result = evaluateEligibility(inputFor("renfe", 60));

    expect(result.status).toBe("eligible");
    expect(result.appliedRules).not.toContain("adif_speed_limit");
  });
});

describe("evaluateEligibility minimum waits", () => {
  it.each([
    {
      name: "Iryo waits 48 hours after the trip",
      operator: "iryo",
      earliestSendAt: "2026-11-16T09:01:00.000Z",
    },
    {
      name: "Renfe waits 24 hours after arrival",
      operator: "renfe",
      earliestSendAt: "2026-11-15T09:01:00.000Z",
    },
    {
      name: "Ouigo waits 7 days after the trip",
      operator: "ouigo",
      earliestSendAt: "2026-11-21T09:01:00.000Z",
    },
  ] as const)("$name", ({ operator, earliestSendAt }) => {
    const result = evaluateEligibility(
      inputFor(operator, 61, {
        scheduledArrival: SCHEDULED_ARRIVAL,
        now: "2026-11-15T00:00:00.000Z",
      }),
    );

    expect(result.status).toBe("eligible");
    expect(Date.parse(result.earliestSendAt ?? "")).toBeGreaterThan(
      Date.parse("2026-11-15T00:00:00.000Z"),
    );
    expect(result.earliestSendAt).toBe(earliestSendAt);
  });
});

describe("evaluateEligibility deadline and exceptional cases", () => {
  it("allows the claim at the three-month deadline and rejects it one day later", () => {
    const scheduledArrival = "2026-11-14T08:00:00.000Z";
    const actualArrival = "2026-11-14T09:01:00.000Z";
    const beforeExpiry = evaluateEligibility(
      inputFor("iryo", 61, {
        scheduledArrival,
        actualArrival,
        now: "2027-02-14T07:00:00.000Z",
      }),
    );
    const afterExpiry = evaluateEligibility(
      inputFor("iryo", 61, {
        scheduledArrival,
        actualArrival,
        now: "2027-02-15T07:00:00.000Z",
      }),
    );

    expect(beforeExpiry.status).toBe("eligible");
    expect(beforeExpiry.deadline).toBe("2027-02-14T07:00:00.000Z");
    expect(afterExpiry.status).toBe("not_eligible");
  });

  it("still sends a force-majeure case for the operator to decide", () => {
    const result = evaluateEligibility(inputFor("iryo", 61, { forceMajeure: true }));

    expect(result.status).toBe("doubtful");
    expect(result.reason).toContain("decide la empresa");
  });

  it("rejects arrival before the scheduled arrival and negative delay", () => {
    const result = evaluateEligibility(
      inputFor("renfe", -1, { scheduledArrival: SCHEDULED_ARRIVAL }),
    );

    expect(result.status).toBe("not_eligible");
    expect(result.delayMinutes).toBe(-1);
  });

  it("calculates delay across the Europe/Madrid spring DST change using instants", () => {
    const result = evaluateEligibility({
      operator: "iryo",
      scheduledDeparture: "2027-03-27T23:00:00+01:00",
      scheduledArrival: "2027-03-28T03:00:00+02:00",
      actualArrival: "2027-03-28T04:01:00+02:00",
      now: "2027-04-10T12:00:00+02:00",
    });

    expect(result.delayMinutes).toBe(61);
    expect(result.status).toBe("eligible");
    expect(result.tier?.percent).toBe(50);
  });
});

describe("evaluateEligibility tier monotonicity", () => {
  it("never decreases the tier percent as delay grows", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<OperatorId>("iryo", "renfe", "ouigo"),
        fc.integer({ min: 0, max: 360 }),
        fc.integer({ min: 0, max: 360 }),
        (operator, firstDelay, secondDelay) => {
          const lowerDelay = Math.min(firstDelay, secondDelay);
          const higherDelay = Math.max(firstDelay, secondDelay);
          const lower = evaluateEligibility(inputFor(operator, lowerDelay)).tier?.percent ?? 0;
          const higher = evaluateEligibility(inputFor(operator, higherDelay)).tier?.percent ?? 0;

          expect(higher).toBeGreaterThanOrEqual(lower);
        },
      ),
      { numRuns: 100, seed: 3114 },
    );
  });
});
