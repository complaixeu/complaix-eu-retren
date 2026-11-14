/**
 * OCR fixtures for domain A (A2, reused by A3). Hand-written, neutral, not real tickets.
 * `ocrFixtureFiles` are placeholder file bytes; `ocrFixtureTexts` is what the OCR returns for
 * each (key = file name). Use `fixtureTextsByHash` to feed the fake provider.
 */
import { createHash } from "node:crypto";

const enc = (s: string) => new TextEncoder().encode(s);

export const ocrFixtureFiles = {
  iryo: enc("placeholder-ticket:iryo"),
  renfe: enc("placeholder-ticket:renfe"),
  ouigo: enc("placeholder-ticket:ouigo"),
  unreadable: enc("placeholder-ticket:unreadable"),
} as const;

export type OcrFixtureName = keyof typeof ocrFixtureFiles;

export const ocrFixtureTexts: Record<OcrFixtureName, string> = {
  iryo: [
    "IRYO",
    "Billete electronico",
    "Localizador: ABC123",
    "Pasajero: Maria Ejemplo Prueba",
    "Origen: Madrid Puerta de Atocha",
    "Destino: Barcelona Sants",
    "Fecha: 12/03/2026",
    "Salida: 09:10  Llegada: 11:55",
    "Tren: IRYO 6201  Coche 3  Asiento 7B",
    "Precio: 54,90 EUR",
  ].join("\n"),
  renfe: [
    "RENFE Viajeros",
    "Billete AVE",
    "Localizador PQR789",
    "Viajero: Juan Muestra Ficticio",
    "Madrid-Puerta de Atocha - Sevilla-Santa Justa",
    "Fecha 05/04/2026  Hora salida 14:30  Hora llegada 17:02",
    "Tren AVE 2093  Coche 5  Plaza 12A",
    "Clase Turista  Importe total 61,35 EUR",
  ].join("\n"),
  ouigo: [
    "OUIGO Espana",
    "Confirmacion de reserva",
    "Referencia de reserva: XYZ456",
    "Pasajero: Ana Demo Inventada",
    "Madrid Chamartin Clara Campoamor -> Valencia Joaquin Sorolla",
    "Fecha de viaje: 20/05/2026",
    "Hora de salida 18:45 - Hora de llegada 20:20",
    "Total pagado: 19,99 EUR",
  ].join("\n"),
  unreadable: "..",
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of each fixture file -> its OCR text, the shape `createFakeOcr` takes. */
export function fixtureTextsByHash(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(ocrFixtureFiles) as OcrFixtureName[]) {
    out[sha256Hex(ocrFixtureFiles[name])] = ocrFixtureTexts[name];
  }
  return out;
}
