import { describe, expect, it } from "vitest";
// The mock on purpose: this is a no-DB unit test of the mock chain. The real createCase needs
// the DB and is covered by tests/unit/claims/create-case.test.ts and tests/integration/claims/.
import { createCase } from "@/features/claims/mock";
import { renderTemplate } from "@/features/documents";
import { evaluateEligibility, getOperatorConfig } from "@/features/rules";
import { fixedClock } from "@/shared/clock";
import {
  CaseStatus,
  EligibilityResult,
  IntakeSubmission,
  OperatorPublicConfig,
  ReplyCategory,
  TicketData,
} from "@/shared/contracts";
import { provider } from "@/shared/providers";

const submission: IntakeSubmission = {
  draftId: "d1",
  ticketPath: "tickets/d1.jpg",
  ticket: {
    operator: "iryo",
    travelDate: "2026-11-10",
    origin: "Madrid",
    destination: "Barcelona",
    bookingRef: "ABC123",
    firstName: "Test",
    lastName: "Passenger",
    scheduledDeparture: "08:00",
    scheduledArrival: "10:30",
  },
  answers: {
    documentType: "passport",
    documentNumber: "X0000000",
    email: "test@example.com",
    actualArrival: { date: "2026-11-10", time: "11:45" },
    previousClaim: { made: false },
    paymentPreference: "money",
  },
  consent: {
    consentId: "c1",
    mandateAccepted: true,
    gdprAccepted: true,
    textVersion: "draft-1",
    acceptedAt: "2026-11-11T09:00:00+01:00",
  },
};

describe("contracts", () => {
  it("the nine case states and six reply categories match ARCHITECTURE §5", () => {
    expect(CaseStatus.options).toHaveLength(9);
    expect(ReplyCategory.options).toEqual([
      "acknowledgement",
      "asks_for_data",
      "approved",
      "denied",
      "refers_to_form",
      "other",
    ]);
  });

  it("TicketData accepts an empty ticket (the AI fills nothing it didn't read)", () => {
    expect(TicketData.parse({})).toEqual({});
  });

  it("rejects a submission without the mandate", () => {
    const bad = { ...submission, consent: { ...submission.consent, mandateAccepted: false } };
    expect(IntakeSubmission.safeParse(bad).success).toBe(false);
  });

  it("rejects malformed times", () => {
    const bad = { ...submission, ticket: { ...submission.ticket, scheduledArrival: "10h30" } };
    expect(IntakeSubmission.safeParse(bad).success).toBe(false);
  });
});

describe("mocks honour the contracts (A → C → B works end to end)", () => {
  it("rules mock returns contract-valid configs; only Iryo is active", () => {
    for (const id of ["iryo", "renfe", "ouigo"] as const) {
      expect(OperatorPublicConfig.safeParse(getOperatorConfig(id)).success).toBe(true);
    }
    expect(getOperatorConfig("iryo").active).toBe(true);
    expect(getOperatorConfig("renfe").active).toBe(false);
  });

  it("createCase (mock) → evaluateEligibility (mock) returns a valid result", async () => {
    const result = await createCase(submission);
    expect(result.status).toBe("waiting_period");
    expect(EligibilityResult.safeParse(result.eligibility).success).toBe(true);
    expect(result.eligibility.delayMinutes).toBe(75);
  });

  it("a short delay is not eligible and closes the case", async () => {
    const onTime = {
      ...submission,
      answers: { ...submission.answers, actualArrival: { date: "2026-11-10", time: "10:40" } },
    };
    expect((await createCase(onTime)).status).toBe("closed");
    expect(
      evaluateEligibility({
        operator: "iryo",
        scheduledDeparture: "2026-11-10T08:00:00+01:00",
        scheduledArrival: "2026-11-10T10:30:00+01:00",
        actualArrival: "2026-11-10T10:40:00+01:00",
        now: "2026-11-13T00:00:00+01:00",
      }).status,
    ).toBe("not_eligible");
  });

  it("templates always carry the case reference", () => {
    expect(renderTemplate("initial_claim", "iryo", { ref: "RTN-ABC" }).subject).toContain(
      "[RTN-ABC]",
    );
  });
});

describe("shared helpers", () => {
  it("providers default to fake and reject unknown values", () => {
    expect(provider("OCR_PROVIDER", {})).toBe("fake");
    expect(provider("LLM_PROVIDER", { LLM_PROVIDER: "gemini" })).toBe("gemini");
    expect(() => provider("MAIL_PROVIDER", { MAIL_PROVIDER: "smtp" })).toThrow();
  });

  it("fixedClock never moves", () => {
    const clock = fixedClock("2026-11-13T10:00:00Z");
    expect(clock.now().toISOString()).toBe("2026-11-13T10:00:00.000Z");
    expect(clock.now()).not.toBe(clock.now());
  });
});
