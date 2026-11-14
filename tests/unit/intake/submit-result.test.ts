import { describe, expect, it } from "vitest";
import {
  RESULT_COOKIE,
  parseResultCookie,
  serializeResult,
} from "@/features/intake/submit/result-cookie";
import { describeResult } from "@/features/intake/submit/present";
import type { CreateCaseResult } from "@/shared/contracts";

// [A7] What the result screen says, and the cookie that lets a reload show it again.

const base = {
  caseId: "7d9d5a39-6e2c-4c5a-a2f0-0e1d86c7b9d1",
  publicRef: "RTN-A1B2C3D4",
};
const eligible: CreateCaseResult = {
  ...base,
  status: "waiting_period",
  eligibility: {
    status: "eligible",
    reason: "Retraso elegible con una indemnización del 100%.",
    delayMinutes: 120,
    tier: { percent: 100, payment: ["voucher", "money"] },
    earliestSendAt: "2026-03-12T09:30:00.000Z",
    deadline: "2026-06-10T08:00:00.000Z",
    appliedRules: ["operator_config"],
    configVersion: "v1",
  },
};

describe("describeResult", () => {
  it("eligible: the earliest send date in Spanish, Madrid time", () => {
    const v = describeResult(eligible);
    expect(v.kind).toBe("eligible");
    expect(v.sendDate).toBe("12 de marzo de 2026");
  });

  it("reads the send date in Europe/Madrid, not UTC", () => {
    const late = {
      ...eligible,
      eligibility: { ...eligible.eligibility, earliestSendAt: "2026-03-12T23:30:00.000Z" },
    };
    expect(describeResult(late).sendDate).toBe("13 de marzo de 2026");
    const summer = {
      ...eligible,
      eligibility: { ...eligible.eligibility, earliestSendAt: "2026-07-14T22:30:00.000Z" },
    };
    expect(describeResult(summer).sendDate).toBe("15 de julio de 2026");
  });

  it("not eligible: keeps the reason and has no send date", () => {
    const v = describeResult({
      ...base,
      status: "closed",
      eligibility: {
        status: "not_eligible",
        reason: "El retraso de 20 minutos no alcanza el umbral de indemnización.",
        delayMinutes: 20,
        earliestSendAt: "2026-03-12T09:30:00.000Z",
        appliedRules: [],
        configVersion: "v1",
      },
    });
    expect(v.kind).toBe("not_eligible");
    expect(v.reason).toMatch(/20 minutos/);
    expect(v.sendDate).toBeNull();
  });

  it("doubtful: still has a send date", () => {
    const v = describeResult({
      ...eligible,
      eligibility: { ...eligible.eligibility, status: "doubtful" },
    });
    expect(v.kind).toBe("doubtful");
    expect(v.sendDate).toBe("12 de marzo de 2026");
  });
});

describe("result cookie", () => {
  it("round-trips a result", () => {
    expect(parseResultCookie(serializeResult(eligible))).toEqual(eligible);
  });

  it.each([undefined, "", "{", "null", '{"caseId":"x"}', "[]"])("ignores %j", (value) => {
    expect(parseResultCookie(value)).toBeNull();
  });

  it("holds no personal data", () => {
    expect(serializeResult(eligible)).not.toMatch(/@|firstName|documentNumber/);
    expect(RESULT_COOKIE).toBe("retren_case");
  });
});
