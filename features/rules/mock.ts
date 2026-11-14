// Mock of domain B (rules). Same exports and types as the real one; behaviour is a simplified,
// contract-valid stand-in so A and C can build before B lands (docs/plans/README.md §1).
import {
  EligibilityResult,
  type EligibilityInput,
  type OperatorId,
  type OperatorPublicConfig,
} from "@/shared/contracts";

const CONFIGS: Record<OperatorId, OperatorPublicConfig> = {
  iryo: {
    id: "iryo",
    displayName: "Iryo",
    active: true,
    channel: { type: "email", address: "atencion.cliente@iryo.eu" },
    responseDays: 30,
    version: "mock",
  },
  renfe: {
    id: "renfe",
    displayName: "Renfe",
    active: false,
    channel: { type: "web_form", url: "https://www.renfe.com/" },
    responseDays: 30,
    version: "mock",
  },
  ouigo: {
    id: "ouigo",
    displayName: "Ouigo",
    active: false,
    channel: { type: "web_form", url: "https://ouigo.zendesk.com/" },
    responseDays: 30,
    version: "mock",
  },
};

export function getOperatorConfig(id: OperatorId): OperatorPublicConfig {
  return CONFIGS[id];
}

const HOUR = 3_600_000;

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const delayMinutes = Math.round(
    (Date.parse(input.actualArrival) - Date.parse(input.scheduledArrival)) / 60_000,
  );
  const eligible = delayMinutes >= 60;
  return EligibilityResult.parse({
    status: eligible ? "eligible" : "not_eligible",
    reason: eligible ? "mock: delay of 60 min or more" : "mock: delay under 60 min",
    delayMinutes,
    tier: eligible ? { percent: delayMinutes > 90 ? 100 : 50, payment: ["voucher"] } : undefined,
    earliestSendAt: eligible
      ? new Date(Date.parse(input.actualArrival) + 48 * HOUR).toISOString()
      : undefined,
    deadline: new Date(Date.parse(input.scheduledDeparture) + 90 * 24 * HOUR).toISOString(),
    appliedRules: ["mock"],
    configVersion: "mock",
  });
}
