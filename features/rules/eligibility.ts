import {
  EligibilityInput,
  EligibilityResult,
  type EligibilityInput as EligibilityInputValue,
  type EligibilityResult as EligibilityResultValue,
} from "@/shared/contracts";
import { getOperatorConfig, type OperatorConfig } from "./operator-config";

type MadridDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const MADRID_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function madridDateTime(instant: number): MadridDateTime {
  const date = new Date(instant);
  const parts = Object.fromEntries(
    MADRID_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    millisecond: date.getUTCMilliseconds(),
  };
}

function madridDateKey(instant: string): string {
  const { year, month, day } = madridDateTime(Date.parse(instant));
  const monthText = String(month).padStart(2, "0");
  const dayText = String(day).padStart(2, "0");

  return `${year}-${monthText}-${dayText}`;
}

function madridWallTimeToInstant(parts: MadridDateTime): number {
  const wallTimeAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let instant = wallTimeAsUtc;

  // Resolve the Europe/Madrid offset for the target wall time, including DST changes.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const localAtGuess = madridDateTime(instant);
    const localAtGuessAsUtc = Date.UTC(
      localAtGuess.year,
      localAtGuess.month - 1,
      localAtGuess.day,
      localAtGuess.hour,
      localAtGuess.minute,
      localAtGuess.second,
      localAtGuess.millisecond,
    );
    const offset = localAtGuessAsUtc - instant;
    const corrected = wallTimeAsUtc - offset;

    if (corrected === instant) break;
    instant = corrected;
  }

  return instant;
}

function addCalendarMonthsInMadrid(instant: string, amount: number): string {
  const source = madridDateTime(Date.parse(instant));
  const monthIndex = source.month - 1 + amount;
  const year = source.year + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const target = {
    ...source,
    year,
    month,
    day: Math.min(source.day, lastDayOfMonth),
  };

  return new Date(madridWallTimeToInstant(target)).toISOString();
}

function addWait(instant: string, config: OperatorConfig): string {
  const wait = config.minWait;
  const multiplier = wait.unit === "hours" ? 60 * 60_000 : 24 * 60 * 60_000;
  const timestamp = Date.parse(instant) + wait.amount * multiplier;

  return new Date(timestamp).toISOString();
}

function notEligible(
  input: EligibilityInputValue,
  config: OperatorConfig,
  delayMinutes: number,
  reason: string,
  appliedRules: string[],
): EligibilityResultValue {
  return EligibilityResult.parse({
    status: "not_eligible",
    reason,
    delayMinutes,
    earliestSendAt: addWait(input.actualArrival, config),
    deadline: addCalendarMonthsInMadrid(input.scheduledDeparture, config.deadline.amount),
    appliedRules,
    configVersion: config.version,
  });
}

/** Evaluates operator eligibility without reading the system clock or calling external services. */
export function evaluateEligibility(rawInput: EligibilityInputValue): EligibilityResultValue {
  const input = EligibilityInput.parse(rawInput);
  const config = getOperatorConfig(input.operator, madridDateKey(input.scheduledDeparture));
  const delayMinutes = Math.floor(
    (Date.parse(input.actualArrival) - Date.parse(input.scheduledArrival)) / 60_000,
  );
  const deadline = addCalendarMonthsInMadrid(input.scheduledDeparture, config.deadline.amount);
  const earliestSendAt = addWait(input.actualArrival, config);
  const appliedRules = ["operator_config", "delay_tier", "minimum_wait", "deadline"];

  if (delayMinutes < 0) {
    return notEligible(
      input,
      config,
      delayMinutes,
      "La llegada fue anterior a la hora prevista; no hay retraso reclamable.",
      appliedRules,
    );
  }

  if (Date.parse(input.now) > Date.parse(deadline)) {
    return EligibilityResult.parse({
      status: "not_eligible",
      reason: "El plazo de tres meses desde el viaje ha vencido.",
      delayMinutes,
      earliestSendAt,
      deadline,
      appliedRules,
      configVersion: config.version,
    });
  }

  const adifRule = config.exclusions.adifSpeedLimit;
  if (adifRule.policy === "excluded" && adifRule.purchaseDateOnOrAfter && input.purchaseDate) {
    appliedRules.push("adif_speed_limit");
    if (input.purchaseDate >= adifRule.purchaseDateOnOrAfter) {
      return EligibilityResult.parse({
        status: "not_eligible",
        reason: "La compra queda excluida por las limitaciones de velocidad de Adif.",
        delayMinutes,
        earliestSendAt,
        deadline,
        appliedRules,
        configVersion: config.version,
      });
    }
  }

  const tier = config.tiers.find(
    ({ minDelayMinutes, maxDelayMinutes }) =>
      delayMinutes >= minDelayMinutes &&
      (maxDelayMinutes === undefined || delayMinutes <= maxDelayMinutes),
  );

  if (!tier) {
    return EligibilityResult.parse({
      status: "not_eligible",
      reason: `El retraso de ${delayMinutes} minutos no alcanza el umbral de indemnización.`,
      delayMinutes,
      earliestSendAt,
      deadline,
      appliedRules,
      configVersion: config.version,
    });
  }

  let payment = tier.payment;
  if (config.exclusions.intermediary.payment) {
    if (input.purchaseChannel === "intermediary") {
      payment = payment.filter((form) => config.exclusions.intermediary.payment?.includes(form));
      appliedRules.push("intermediary_payment");
    } else if (input.purchasedAtCasaIryo) {
      payment = payment.filter((form) => config.exclusions.intermediary.payment?.includes(form));
      appliedRules.push("casa_iryo_payment");
    }
  }

  let status = tier.status;
  let reason =
    status === "doubtful"
      ? "Con 60 minutos exactos el derecho es dudoso; se envía igualmente."
      : `Retraso elegible con una indemnización del ${tier.percent}%.`;

  if (input.forceMajeure && config.exclusions.forceMajeure.sendAnyway) {
    status = "doubtful";
    reason = "Posible fuerza mayor: decide la empresa; se envía igualmente.";
    appliedRules.push("force_majeure_send_anyway");
  }

  return EligibilityResult.parse({
    status,
    reason,
    delayMinutes,
    tier: { percent: tier.percent, payment },
    earliestSendAt,
    deadline,
    appliedRules,
    configVersion: config.version,
  });
}
