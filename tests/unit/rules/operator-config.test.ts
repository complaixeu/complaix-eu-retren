import { describe, expect, it } from "vitest";
import {
  OperatorConfig,
  getOperatorConfig,
  selectOperatorConfig,
  type OperatorConfig as OperatorConfigValue,
} from "@/features/rules/operator-config";

const baseConfig = {
  id: "iryo",
  displayName: "Iryo",
  version: "2026-01",
  validFrom: "2026-01-01",
  sourceUrls: ["https://iryo.eu/conditions"],
  consultedAt: "2026-11-13",
  channel: { type: "email", address: "claims@example.test" },
  active: true,
  responseDays: 30,
  minWait: { amount: 48, unit: "hours", anchor: "trip" },
  deadline: { amount: 3, unit: "months", anchor: "trip" },
  tiers: [
    {
      minDelayMinutes: 61,
      percent: 50,
      payment: ["voucher"],
      status: "eligible",
    },
  ],
  exclusions: {
    forceMajeure: { sendAnyway: true },
    adifSpeedLimit: { policy: "operator_decides" },
    intermediary: { payment: ["voucher"] },
  },
  payment: {
    default: ["voucher"],
    onMoneyRequest: ["money"],
  },
  templates: { style: "formal" },
} as const;

describe("OperatorConfig", () => {
  it("accepts a complete config", () => {
    expect(OperatorConfig.parse(baseConfig)).toEqual(baseConfig);
  });

  it.each([
    "id",
    "displayName",
    "version",
    "validFrom",
    "sourceUrls",
    "consultedAt",
    "channel",
    "active",
    "responseDays",
    "minWait",
    "deadline",
    "tiers",
    "exclusions",
    "payment",
    "templates",
  ] as const)("rejects a config without %s", (field) => {
    const incomplete = { ...baseConfig } as Record<string, unknown>;
    delete incomplete[field];

    expect(() => OperatorConfig.parse(incomplete)).toThrow();
  });
});

describe("getOperatorConfig", () => {
  const oldVersion: OperatorConfigValue = OperatorConfig.parse({
    ...baseConfig,
    version: "2026-01",
    validFrom: "2026-01-01",
  });
  const newVersion: OperatorConfigValue = OperatorConfig.parse({
    ...baseConfig,
    version: "2026-06",
    validFrom: "2026-06-01",
  });
  const versions = [newVersion, oldVersion];

  it.each([
    ["before the next validFrom", "2026-05-31", "2026-01"],
    ["exactly on validFrom", "2026-06-01", "2026-06"],
    ["after validFrom", "2026-10-15", "2026-06"],
  ])("picks the version %s", (_case, onDate, expectedVersion) => {
    expect(selectOperatorConfig("iryo", onDate, versions).version).toBe(expectedVersion);
  });

  it("rejects a date before the first known version", () => {
    expect(() => selectOperatorConfig("iryo", "2025-12-31", versions)).toThrow(
      /No configuration for iryo/,
    );
  });

  it("uses the built-in registry through the two-argument public contract", () => {
    expect(getOperatorConfig("iryo", "2026-11-13").version).toBe("2026-11-13");
    expect(getOperatorConfig("iryo", new Date("2026-11-14T00:00:00Z")).version).toBe("2026-11-13");
  });
});
