/**
 * Extraction fixtures for domain A ([A3]). Hand-written and invented, not real tickets.
 *
 * `modelOutputs` is what a model "answers" for each OCR text of ./ocr.ts: the raw JSON, before
 * validation and the "never invent" post-check, with `null` for what isn't printed (Gemini's
 * shape). Some values differ from the text only in what the post-check normalizes (accents,
 * case, spacing, date and time formats), so the layouts also exercise it. `expected` is what must
 * come out after the post-check.
 */
import type { TicketData, TicketField } from "@/shared/contracts";
import { ocrFixtureTexts, sha256Hex, type OcrFixtureName } from "./ocr";

type Layout = Exclude<OcrFixtureName, "unreadable">;

export const modelOutputs: Record<Layout, Record<string, unknown>> = {
  iryo: {
    operator: "iryo",
    travelDate: "2026-03-12", // printed 12/03/2026
    origin: "Madrid Puerta de Atocha",
    destination: "Barcelona Sants",
    bookingRef: "ABC123",
    ticketNumber: null,
    firstName: "María", // printed without the accent
    lastName: "Ejemplo Prueba",
    scheduledDeparture: "09:10",
    scheduledArrival: "11:55",
    trainNumber: "IRYO 6201",
    price: "54,90 EUR",
    purchaseDate: null,
    purchaseChannel: null,
  },
  renfe: {
    operator: "renfe",
    travelDate: "2026-04-05", // printed 05/04/2026
    origin: "Madrid-Puerta de Atocha",
    destination: "Sevilla-Santa Justa",
    bookingRef: "PQR789",
    ticketNumber: null,
    firstName: "Juan",
    lastName: "MUESTRA FICTICIO", // case differs
    scheduledDeparture: "14:30",
    scheduledArrival: "17:02",
    trainNumber: "AVE 2093",
    price: "61,35 EUR",
    purchaseDate: null,
    purchaseChannel: null,
  },
  ouigo: {
    operator: "ouigo",
    travelDate: "2026-05-20",
    origin: "Madrid Chamartín  Clara Campoamor", // accent and a double space
    destination: "Valencia Joaquín Sorolla",
    bookingRef: "XYZ456",
    ticketNumber: null,
    firstName: "Ana",
    lastName: "Demo Inventada",
    scheduledDeparture: "18:45",
    scheduledArrival: "20:20",
    trainNumber: null,
    price: "19,99 EUR",
    purchaseDate: null,
    purchaseChannel: null,
  },
};

export const expectedData: Record<Layout, TicketData> = {
  iryo: {
    operator: "iryo",
    travelDate: "2026-03-12",
    origin: "Madrid Puerta de Atocha",
    destination: "Barcelona Sants",
    bookingRef: "ABC123",
    firstName: "María",
    lastName: "Ejemplo Prueba",
    scheduledDeparture: "09:10",
    scheduledArrival: "11:55",
    trainNumber: "IRYO 6201",
    price: "54,90 EUR",
  },
  renfe: {
    operator: "renfe",
    travelDate: "2026-04-05",
    origin: "Madrid-Puerta de Atocha",
    destination: "Sevilla-Santa Justa",
    bookingRef: "PQR789",
    firstName: "Juan",
    lastName: "MUESTRA FICTICIO",
    scheduledDeparture: "14:30",
    scheduledArrival: "17:02",
    trainNumber: "AVE 2093",
    price: "61,35 EUR",
  },
  ouigo: {
    operator: "ouigo",
    travelDate: "2026-05-20",
    origin: "Madrid Chamartín Clara Campoamor",
    destination: "Valencia Joaquín Sorolla",
    bookingRef: "XYZ456",
    firstName: "Ana",
    lastName: "Demo Inventada",
    scheduledDeparture: "18:45",
    scheduledArrival: "20:20",
    price: "19,99 EUR",
  },
};

/** Fields none of the layouts print, so they are always missing. */
const NEVER_PRINTED: TicketField[] = ["ticketNumber", "purchaseDate", "purchaseChannel"];

export const expectedMissing: Record<Layout, TicketField[]> = {
  iryo: NEVER_PRINTED,
  renfe: NEVER_PRINTED,
  ouigo: ["ticketNumber", "trainNumber", "purchaseDate", "purchaseChannel"],
};

/**
 * The Iryo answer with invented values: none of these appear in the Iryo text, so every one must
 * be dropped and end in `missing`, while the true values stay.
 */
export const hallucinatedIryo: Record<string, unknown> = {
  ...modelOutputs.iryo,
  ticketNumber: "7012345678901", // not printed at all
  purchaseDate: "2026-03-01", // no such date in the text
  lastName: "Ejemplo García", // half right is still wrong
  scheduledArrival: "11:50", // printed 11:55
  bookingRef: "ABC12", // a prefix of the real one
  purchaseChannel: "direct", // never printed, so never kept
};

export const hallucinatedFields: TicketField[] = [
  "ticketNumber",
  "purchaseDate",
  "lastName",
  "scheduledArrival",
  "bookingRef",
  "purchaseChannel",
];

/** sha256 of each OCR fixture text -> the model's raw answer, the shape the fake extractor takes. */
export function modelOutputsByTextHash(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    (Object.keys(modelOutputs) as Layout[]).map((name) => [
      sha256Hex(new TextEncoder().encode(ocrFixtureTexts[name])),
      modelOutputs[name],
    ]),
  );
}
