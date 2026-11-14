import { z } from "zod";
import {
  OperatorId,
  OperatorPublicConfig,
  PaymentForm,
  type OperatorId as OperatorIdValue,
} from "@/shared/contracts";

const IsoDate = z.iso.date();

const WaitPeriod = z.object({
  amount: z.number().int().positive(),
  unit: z.enum(["hours", "days"]),
  anchor: z.enum(["trip", "arrival"]),
});

const Deadline = z.object({
  amount: z.number().int().positive(),
  unit: z.literal("months"),
  anchor: z.literal("trip"),
});

const CompensationTier = z
  .object({
    minDelayMinutes: z.number().int().nonnegative(),
    maxDelayMinutes: z.number().int().nonnegative().optional(),
    percent: z.number().min(0).max(100),
    payment: z.array(PaymentForm).min(1),
    status: z.enum(["eligible", "doubtful"]),
  })
  .refine(
    (tier) => tier.maxDelayMinutes === undefined || tier.maxDelayMinutes >= tier.minDelayMinutes,
    { message: "maxDelayMinutes must not be lower than minDelayMinutes" },
  );

export const OperatorConfig = OperatorPublicConfig.extend({
  id: OperatorId,
  version: z.string().min(1),
  validFrom: IsoDate,
  sourceUrls: z.array(z.url()).min(1),
  consultedAt: IsoDate,
  minWait: WaitPeriod,
  deadline: Deadline,
  tiers: z.array(CompensationTier).min(1),
  exclusions: z.object({
    forceMajeure: z.object({
      sendAnyway: z.boolean(),
      note: z.string().min(1).optional(),
    }),
    adifSpeedLimit: z.object({
      policy: z.enum(["operator_decides", "excluded", "not_applicable"]),
      purchaseDateOnOrAfter: IsoDate.optional(),
    }),
    intermediary: z.object({
      payment: z.array(PaymentForm).min(1).optional(),
    }),
  }),
  payment: z.object({
    default: z.array(PaymentForm).min(1),
    onMoneyRequest: z.array(PaymentForm).min(1).optional(),
  }),
  templates: z.object({
    style: z.string().min(1),
  }),
});
export type OperatorConfig = z.infer<typeof OperatorConfig>;

const DEFAULT_OPERATOR_CONFIGS: readonly OperatorConfig[] = [
  OperatorConfig.parse({
    id: "iryo",
    displayName: "Iryo",
    version: "2026-11-13",
    validFrom: "2026-11-13",
    sourceUrls: [
      "https://iryo.eu/es/viaja/servicio-postventa",
      "https://iryo.eu/es/legal/condiciones-generales-del-contrato-de-transportes",
      "https://iryo.eu/es/atencion-al-cliente",
    ],
    consultedAt: "2026-11-13",
    channel: { type: "email", address: "atencion.cliente@iryo.eu" },
    active: true,
    responseDays: 30,
    minWait: { amount: 48, unit: "hours", anchor: "trip" },
    deadline: { amount: 3, unit: "months", anchor: "trip" },
    tiers: [
      {
        minDelayMinutes: 60,
        maxDelayMinutes: 60,
        percent: 50,
        payment: ["voucher"],
        status: "doubtful",
      },
      {
        minDelayMinutes: 61,
        maxDelayMinutes: 90,
        percent: 50,
        payment: ["voucher", "money"],
        status: "eligible",
      },
      {
        minDelayMinutes: 91,
        percent: 100,
        payment: ["voucher", "money"],
        status: "eligible",
      },
    ],
    exclusions: {
      forceMajeure: { sendAnyway: true, note: "decide la empresa" },
      adifSpeedLimit: { policy: "operator_decides" },
      intermediary: { payment: ["voucher"] },
    },
    payment: { default: ["voucher"], onMoneyRequest: ["money"] },
    templates: { style: "formal" },
  }),
  OperatorConfig.parse({
    id: "renfe",
    displayName: "Renfe",
    version: "2026-11-13",
    validFrom: "2026-11-13",
    sourceUrls: [
      "https://www.renfe.com/es/es/ayuda/compromiso-puntualidad",
      "https://www.renfe.com/es/es/ayuda/contactar-renfe.html",
      "https://www.renfe.com/es/es/normativa.html",
    ],
    consultedAt: "2026-11-13",
    channel: { type: "web_form", url: "https://venta.renfe.com/vol/claimsMenu.do" },
    active: false,
    responseDays: 30,
    minWait: { amount: 24, unit: "hours", anchor: "arrival" },
    deadline: { amount: 3, unit: "months", anchor: "trip" },
    tiers: [
      {
        minDelayMinutes: 60,
        maxDelayMinutes: 90,
        percent: 50,
        payment: ["money", "voucher"],
        status: "eligible",
      },
      {
        minDelayMinutes: 91,
        percent: 100,
        payment: ["money", "voucher"],
        status: "eligible",
      },
    ],
    exclusions: {
      forceMajeure: { sendAnyway: true, note: "decide la empresa" },
      adifSpeedLimit: { policy: "excluded", purchaseDateOnOrAfter: "2026-01-31" },
      intermediary: {},
    },
    payment: { default: ["money", "voucher"] },
    templates: { style: "formal" },
  }),
  OperatorConfig.parse({
    id: "ouigo",
    displayName: "Ouigo",
    version: "2026-11-13",
    validFrom: "2026-11-13",
    sourceUrls: ["https://www.ouigo.com/es/condiciones-generales-de-transporte-ouigo"],
    consultedAt: "2026-11-13",
    channel: { type: "web_form", url: "https://ouigo.zendesk.com/hc/es/requests/new" },
    active: false,
    responseDays: 30,
    minWait: { amount: 7, unit: "days", anchor: "trip" },
    deadline: { amount: 3, unit: "months", anchor: "trip" },
    tiers: [
      {
        minDelayMinutes: 30,
        maxDelayMinutes: 59,
        percent: 50,
        payment: ["non_refundable_voucher"],
        status: "eligible",
      },
      {
        minDelayMinutes: 60,
        maxDelayMinutes: 89,
        percent: 50,
        payment: ["refundable_voucher"],
        status: "eligible",
      },
      {
        minDelayMinutes: 90,
        percent: 100,
        payment: ["refundable_voucher"],
        status: "eligible",
      },
    ],
    exclusions: {
      forceMajeure: { sendAnyway: true, note: "decide la empresa" },
      adifSpeedLimit: { policy: "not_applicable" },
      intermediary: {},
    },
    payment: { default: ["non_refundable_voucher", "refundable_voucher"] },
    templates: { style: "formal" },
  }),
];

function dateKey(onDate: string | Date): string {
  if (onDate instanceof Date) {
    if (Number.isNaN(onDate.getTime())) {
      throw new Error("Invalid configuration date");
    }

    return onDate.toISOString().slice(0, 10);
  }

  return IsoDate.parse(onDate);
}

/** Selects the newest config whose validFrom is on or before the requested date. */
export function selectOperatorConfig(
  id: OperatorIdValue,
  onDate: string | Date,
  configs: readonly OperatorConfig[],
): OperatorConfig {
  const requestedDate = dateKey(onDate);
  const config = configs
    .filter((candidate) => candidate.id === id && candidate.validFrom <= requestedDate)
    .sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];

  if (!config) {
    throw new Error(`No configuration for ${id} on ${requestedDate}`);
  }

  return config;
}

export function getOperatorConfig(id: OperatorIdValue, onDate: string | Date): OperatorConfig {
  return selectOperatorConfig(id, onDate, DEFAULT_OPERATOR_CONFIGS);
}
