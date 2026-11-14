import type { EuFormData } from "@/shared/contracts";

export const fullEuFormData = {
  previousClaim: {
    date: "2026-10-01",
    recipient: "OPERADOR SINTÉTICO",
    means: "CANAL SINTÉTICO",
  },
  operatorName: "OPERADOR SINTÉTICO",
  scheduled: {
    date: "2026-10-02",
    origin: "ORIGEN SINTÉTICO",
    destination: "DESTINO SINTÉTICO",
    departureTime: "08:00",
    arrivalTime: "09:00",
    trainNumber: "TREN-SINTÉTICO",
    ticketRef: "BILLETE-SINTÉTICO",
    price: "10,00 EUR",
  },
  actual: {
    arrivalDate: "2026-10-02",
    departureTime: "08:05",
    arrivalTime: "10:01",
    trainNumber: "TREN-REAL-SINTÉTICO",
  },
  delayMinutes: 61,
  passenger: {
    firstName: "NOMBRE SINTÉTICO",
    lastName: "APELLIDOS SINTÉTICOS",
  },
  address: {
    street: "CALLE SINTÉTICA",
    number: "NÚMERO SINTÉTICO",
    country: "PAÍS SINTÉTICO",
    postalCode: "CP-SINTÉTICO",
    city: "MUNICIPIO SINTÉTICO",
  },
  bookingEmail: "synthetic@example.invalid",
  phone: "TELÉFONO-SINTÉTICO",
  paymentPreference: "money",
  paymentDetails: {
    iban: "IBAN-SINTÉTICO",
    swift: "SWIFT-SINTÉTICO",
    other: "MEDIO-PAGO-SINTÉTICO",
    holder: "TITULAR SINTÉTICO",
  },
  extraInfo: "INFORMACIÓN SINTÉTICA",
  gdprAccepted: true,
  request: {
    date: "2026-10-03",
    place: "LUGAR SINTÉTICO",
  },
  representedName: "PERSONA REPRESENTADA SINTÉTICA",
} satisfies EuFormData & {
  address: {
    street: string;
    number: string;
    country: string;
    postalCode: string;
    city: string;
  };
  phone: string;
  paymentDetails: { iban: string; swift: string; other: string; holder: string };
  extraInfo: string;
};

export const minimalEuFormData = {
  operatorName: "OPERADOR SINTÉTICO",
  scheduled: {
    date: "2026-10-02",
    origin: "ORIGEN SINTÉTICO",
    destination: "DESTINO SINTÉTICO",
    departureTime: "08:00",
    arrivalTime: "09:00",
    ticketRef: "BILLETE-SINTÉTICO",
  },
  actual: {
    arrivalDate: "2026-10-02",
    arrivalTime: "09:59",
  },
  delayMinutes: 59,
  passenger: {
    firstName: "NOMBRE SINTÉTICO",
    lastName: "APELLIDOS SINTÉTICOS",
  },
  paymentPreference: "voucher",
  gdprAccepted: false,
  request: {
    date: "2026-10-03",
    place: "LUGAR SINTÉTICO",
  },
  representedName: "PERSONA REPRESENTADA SINTÉTICA",
} satisfies EuFormData;
