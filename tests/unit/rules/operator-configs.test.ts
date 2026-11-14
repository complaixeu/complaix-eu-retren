import { describe, expect, it } from "vitest";
import { OperatorConfig, getOperatorConfig } from "@/features/rules/operator-config";
import type { OperatorId } from "@/shared/contracts";

const operatorIds: OperatorId[] = ["iryo", "renfe", "ouigo"];

function policySnapshot(id: OperatorId) {
  const config = getOperatorConfig(id, "2026-11-13");

  return {
    id: config.id,
    version: config.version,
    validFrom: config.validFrom,
    sourceUrls: config.sourceUrls,
    consultedAt: config.consultedAt,
    active: config.active,
    channel: config.channel,
    responseDays: config.responseDays,
    minWait: config.minWait,
    deadline: config.deadline,
    tiers: config.tiers,
    exclusions: config.exclusions,
    payment: config.payment,
  };
}

describe("operator configurations", () => {
  it.each(operatorIds)("%s config passes the schema", (id) => {
    expect(() => OperatorConfig.parse(getOperatorConfig(id, "2026-11-13"))).not.toThrow();
  });

  it("keeps the operator policy table values in a reviewed snapshot", () => {
    expect(operatorIds.map(policySnapshot)).toMatchSnapshot();
  });

  it.each(["renfe", "ouigo"] as const)(
    "keeps %s inactive until its email channel is confirmed",
    (id) => {
      expect(getOperatorConfig(id, "2026-11-13").active).toBe(false);
    },
  );
});
