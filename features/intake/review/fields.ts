import type { TicketField } from "@/shared/contracts";

/**
 * The review step's fields ([A4]): one per `TicketData` field, in the order the screen shows
 * them, with their Spanish labels and input kinds. Plain data, so the server page can pass it to
 * the client form as props.
 */

export type ReviewInputName = TicketField | "bookingRefConfirmed";

export type ReviewErrorCode =
  | "required"
  | "too_long"
  | "invalid_choice"
  | "invalid_date"
  | "future_date"
  | "purchase_after_travel"
  | "invalid_time"
  | "same_time"
  | "unconfirmed";

export type ReviewErrors = Partial<Record<ReviewInputName, ReviewErrorCode>>;

/** Shown under a field but never blocking: the value is fine, worth a second look. */
export type ReviewWarningCode = "next_day_arrival" | "long_trip";

export type ReviewWarnings = Partial<Record<ReviewInputName, ReviewWarningCode[]>>;

/** A trip longer than this (in minutes) gets the `long_trip` note. */
export const LONG_TRIP_MINUTES = 10 * 60;

export type ReviewSection = "ticket" | "trip" | "passenger" | "purchase";

export interface ReviewField {
  name: TicketField;
  label: string;
  section: ReviewSection;
  /** `choice` is a group of radios. */
  kind: "text" | "date" | "time" | "choice";
  /** Required to create a case (`SubmittedTicket`). */
  required: boolean;
  help?: string;
  options?: readonly { value: string; label: string }[];
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "decimal";
}

export const REVIEW_SECTIONS: readonly { id: ReviewSection; title: string }[] = [
  { id: "ticket", title: "Billete" },
  { id: "trip", title: "Viaje" },
  { id: "passenger", title: "Viajero" },
  { id: "purchase", title: "Compra" },
];

export const REVIEW_FIELDS = [
  {
    name: "operator",
    label: "Compañía",
    section: "ticket",
    kind: "choice",
    required: true,
    options: [
      { value: "iryo", label: "Iryo" },
      { value: "renfe", label: "Renfe" },
      { value: "ouigo", label: "Ouigo" },
    ],
  },
  {
    name: "bookingRef",
    label: "Localizador",
    section: "ticket",
    kind: "text",
    required: true,
    help: "Cópialo letra a letra, tal como aparece en el billete.",
    autoComplete: "off",
  },
  {
    name: "ticketNumber",
    label: "Número de billete",
    section: "ticket",
    kind: "text",
    required: false,
    autoComplete: "off",
  },
  { name: "travelDate", label: "Fecha del viaje", section: "trip", kind: "date", required: true },
  { name: "origin", label: "Estación de origen", section: "trip", kind: "text", required: true },
  {
    name: "destination",
    label: "Estación de destino",
    section: "trip",
    kind: "text",
    required: true,
  },
  {
    name: "scheduledDeparture",
    label: "Hora de salida prevista",
    section: "trip",
    kind: "time",
    required: true,
  },
  {
    name: "scheduledArrival",
    label: "Hora de llegada prevista",
    section: "trip",
    kind: "time",
    required: true,
    help: "La que pone el billete, no la hora a la que llegaste.",
  },
  {
    name: "trainNumber",
    label: "Número de tren",
    section: "trip",
    kind: "text",
    required: false,
    autoComplete: "off",
  },
  {
    name: "firstName",
    label: "Nombre",
    section: "passenger",
    kind: "text",
    required: true,
    autoComplete: "given-name",
  },
  {
    name: "lastName",
    label: "Apellidos",
    section: "passenger",
    kind: "text",
    required: true,
    autoComplete: "family-name",
  },
  {
    name: "price",
    label: "Precio",
    section: "purchase",
    kind: "text",
    required: false,
    help: "Tal como aparece en el billete, por ejemplo 45,60 €.",
    inputMode: "decimal",
    autoComplete: "off",
  },
  {
    name: "purchaseDate",
    label: "Fecha de compra",
    section: "purchase",
    kind: "date",
    required: false,
  },
  {
    name: "purchaseChannel",
    label: "¿Dónde lo compraste?",
    section: "purchase",
    kind: "choice",
    required: false,
    options: [
      { value: "direct", label: "En la web, la app o la taquilla de la compañía" },
      { value: "intermediary", label: "En una agencia u otra web" },
      { value: "unknown", label: "No lo recuerdo" },
    ],
  },
] as const satisfies readonly ReviewField[];

export const REVIEW_REQUIRED_FIELDS: readonly TicketField[] = REVIEW_FIELDS.filter(
  (f) => f.required,
).map((f) => f.name);

/** Longest text accepted in any field: well over any station or name, short of abuse. */
export const REVIEW_MAX_LENGTH = 120;

const requiredMessages: Partial<Record<TicketField, string>> = {
  operator: "Elige la compañía del billete.",
  bookingRef: "Escribe el localizador tal como aparece en el billete.",
  travelDate: "Escribe la fecha del viaje.",
  origin: "Escribe la estación de origen.",
  destination: "Escribe la estación de destino.",
  scheduledDeparture: "Escribe la hora de salida prevista.",
  scheduledArrival: "Escribe la hora de llegada prevista.",
  firstName: "Escribe el nombre que aparece en el billete.",
  lastName: "Escribe los apellidos que aparecen en el billete.",
};

/** The message shown under a field for an error code. Says what happened and what to do. */
export function reviewErrorMessage(input: ReviewInputName, code: ReviewErrorCode): string {
  switch (code) {
    case "required":
      return requiredMessages[input as TicketField] ?? "Rellena este dato.";
    case "too_long":
      return "Es demasiado largo. Revisa lo que has escrito.";
    case "invalid_choice":
      return input === "operator" ? requiredMessages.operator! : "Elige una de las opciones.";
    case "invalid_date":
      return "Esa fecha no existe. Escríbela como día/mes/año, por ejemplo 12/03/2026.";
    case "future_date":
      return input === "travelDate"
        ? "La fecha del viaje no puede ser posterior a hoy. Revisa el día y el mes."
        : "La fecha de compra no puede ser posterior a hoy.";
    case "purchase_after_travel":
      return "La fecha de compra no puede ser posterior a la del viaje.";
    case "invalid_time":
      return "Escribe la hora como HH:MM, por ejemplo 09:05.";
    case "same_time":
      return "La hora de llegada no puede ser la misma que la de salida. Revisa las dos.";
    case "unconfirmed":
      return "Marca la casilla cuando hayas comprobado que el localizador coincide con el del billete.";
  }
}

/** The messages for a set of errors, per input: what the server action hands the form. */
export function reviewErrorMessages(
  errors: ReviewErrors,
): Partial<Record<ReviewInputName, string>> {
  const out: Partial<Record<ReviewInputName, string>> = {};
  for (const [input, code] of Object.entries(errors) as [ReviewInputName, ReviewErrorCode][]) {
    out[input] = reviewErrorMessage(input, code);
  }
  return out;
}

const warningMessages: Record<ReviewWarningCode, string> = {
  next_day_arrival: "Llegas después de medianoche: lo guardamos como llegada del día siguiente.",
  long_trip: "Según estas horas, el viaje dura más de 10 horas. Comprueba que son las del billete.",
};

/** The note shown under a field for a warning code. */
export function reviewWarningMessage(code: ReviewWarningCode): string {
  return warningMessages[code];
}

/** Every warning message by code, for the client form, which shows them as the user types. */
export const REVIEW_WARNING_MESSAGES: Readonly<Record<ReviewWarningCode, string>> = warningMessages;
