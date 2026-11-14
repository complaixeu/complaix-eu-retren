// GENERATED copy of tests/fixtures/intake/{ocr,extraction}.ts, so the build bundles the fake
// OCR texts and fake model answers of the demo tickets ([A3]) and a deployment never reads the
// repo's files at runtime. Used only while OCR_PROVIDER / LLM_PROVIDER are `fake`.
// tests/unit/intake/extraction.test.ts fails when it drifts from them; regenerate by copying
// `{ ...fixtureTextsByHash(), ...uploadTextsByHash() }` and `modelOutputsByTextHash()`.
// Invented, neutral data only: no real ticket.

/** sha256 (hex) of a placeholder ticket file -> the text the fake OCR returns for it. */
export const DEMO_OCR_TEXTS: Record<string, string> = {
  "26b37b3937270059cafdea17a4f07e1e1b6e2a492e0de3d4cf476de15364b581":
    "IRYO\nBillete electronico\nLocalizador: ABC123\nPasajero: Maria Ejemplo Prueba\nOrigen: Madrid Puerta de Atocha\nDestino: Barcelona Sants\nFecha: 12/03/2026\nSalida: 09:10  Llegada: 11:55\nTren: IRYO 6201  Coche 3  Asiento 7B\nPrecio: 54,90 EUR",
  aceffc0e2f28fdfed36158a4740b05a1aff6c9e42db54365b5359c2e962eb5cc:
    "RENFE Viajeros\nBillete AVE\nLocalizador PQR789\nViajero: Juan Muestra Ficticio\nMadrid-Puerta de Atocha - Sevilla-Santa Justa\nFecha 05/04/2026  Hora salida 14:30  Hora llegada 17:02\nTren AVE 2093  Coche 5  Plaza 12A\nClase Turista  Importe total 61,35 EUR",
  "17579cc33b952b1af920af32031f0d893e9ca686180d693be80fc01d7c4aa45e":
    "OUIGO Espana\nConfirmacion de reserva\nReferencia de reserva: XYZ456\nPasajero: Ana Demo Inventada\nMadrid Chamartin Clara Campoamor -> Valencia Joaquin Sorolla\nFecha de viaje: 20/05/2026\nHora de salida 18:45 - Hora de llegada 20:20\nTotal pagado: 19,99 EUR",
  bdfa594c9b3f5f34ed3239b60208ac91af0595e33cd1220504a052e1d4ea060f: "..",
  eaa4a94ea300e0d2c775968cbe42f0b5b51ceafdeb73d64e9efddf6d4e880865:
    "IRYO\nBillete electronico\nLocalizador: ABC123\nPasajero: Maria Ejemplo Prueba\nOrigen: Madrid Puerta de Atocha\nDestino: Barcelona Sants\nFecha: 12/03/2026\nSalida: 09:10  Llegada: 11:55\nTren: IRYO 6201  Coche 3  Asiento 7B\nPrecio: 54,90 EUR",
  a9fcf033bd5771fa610fd2c1684b499533fd24661c43162d59a4170aca69d0ba:
    "RENFE Viajeros\nBillete AVE\nLocalizador PQR789\nViajero: Juan Muestra Ficticio\nMadrid-Puerta de Atocha - Sevilla-Santa Justa\nFecha 05/04/2026  Hora salida 14:30  Hora llegada 17:02\nTren AVE 2093  Coche 5  Plaza 12A\nClase Turista  Importe total 61,35 EUR",
  "603726f334343c492a107ff573c0c05a1b7621767bbee41a8a802a79b9a6159b":
    "OUIGO Espana\nConfirmacion de reserva\nReferencia de reserva: XYZ456\nPasajero: Ana Demo Inventada\nMadrid Chamartin Clara Campoamor -> Valencia Joaquin Sorolla\nFecha de viaje: 20/05/2026\nHora de salida 18:45 - Hora de llegada 20:20\nTotal pagado: 19,99 EUR",
  "9864d186547313be602f44e4df01a3f54c46587be92e30458c5e26503cb6de94": "..",
};

/** sha256 (hex) of an OCR text -> the fake model's raw answer for it. */
export const DEMO_MODEL_OUTPUTS: Record<string, Record<string, unknown>> = {
  d2a76278f9ca0db911514f94605a5d6e854d143ed070017ef2d7e98150f1d64e: {
    operator: "iryo",
    travelDate: "2026-03-12",
    origin: "Madrid Puerta de Atocha",
    destination: "Barcelona Sants",
    bookingRef: "ABC123",
    ticketNumber: null,
    firstName: "María",
    lastName: "Ejemplo Prueba",
    scheduledDeparture: "09:10",
    scheduledArrival: "11:55",
    trainNumber: "IRYO 6201",
    price: "54,90 EUR",
    purchaseDate: null,
    purchaseChannel: null,
  },
  f643d8e079a5d0699ac01f445f8d066d4edf3c0f6803692b2a5da1dbe5ace69b: {
    operator: "renfe",
    travelDate: "2026-04-05",
    origin: "Madrid-Puerta de Atocha",
    destination: "Sevilla-Santa Justa",
    bookingRef: "PQR789",
    ticketNumber: null,
    firstName: "Juan",
    lastName: "MUESTRA FICTICIO",
    scheduledDeparture: "14:30",
    scheduledArrival: "17:02",
    trainNumber: "AVE 2093",
    price: "61,35 EUR",
    purchaseDate: null,
    purchaseChannel: null,
  },
  "4ca6cbb2ad6406c920aada648e7d64adf762a9d12e33b8bb7f9d5623f68fba3c": {
    operator: "ouigo",
    travelDate: "2026-05-20",
    origin: "Madrid Chamartín  Clara Campoamor",
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
