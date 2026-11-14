import { readFile } from "node:fs/promises";
import path from "node:path";

import { PDFBool, PDFDocument, PDFName, type PDFForm } from "pdf-lib";

import { EuFormData, type EuFormData as EuFormDataType } from "@/shared/contracts";

const TEMPLATE_PATH = path.join(process.cwd(), "templates/formulario_ue_es.pdf");

const fields = {
  reasonDelay: "Motivi della richiesta 1",
  reasonCancellation: "Motivi della richiesta 2",
  reasonMissedConnection: "Motivi della richiesta 3",
  previousClaimDate: "Data 1",
  previousClaimRecipient: "Destinatario della richiesta 1",
  previousClaimMeans: "Richiesta precedente 1",
  operator: "Nome dell'impresa ferroviaria 1",
  scheduledDate: "Viaggio previsto 1",
  scheduledOrigin: "Viaggio previsto 2",
  scheduledDestination: "Viaggio previsto 3",
  scheduledDeparture: "Viaggio previsto 4",
  scheduledArrival: "Scheduled journey 5",
  scheduledTrain: "Viaggio previsto 6",
  ticketReference: "Viaggio previsto 7",
  ticketPrice: "Viaggio previsto 8",
  actualArrivalDate: "Viaggio effettivo 1",
  actualDeparture: "Viaggio effettivo 2",
  actualArrival: "Viaggio effettivo 3",
  actualTrain: "Viaggio effettivo 4",
  missedConnection: "Viaggio effettivo 5",
  requestRefund: "Specificare la richiesta/le richieste 1",
  requestCompensation: "Specificare la richiesta/le richieste 2",
  tier60To119: "Selezionare una delle 3 opzioni 1",
  tier120Plus: "Selezionare una delle 3 opzioni 2",
  tierRecurring: "Selezionare una delle 3 opzioni 3",
  requestCosts: "Specificare la richiesta/le richieste 3",
  firstName: "Nome 1",
  lastName: "Nome 2",
  addressStreet: "Indirizzo 1",
  addressNumber: "Indirizzo 2",
  addressCountry: "Indirizzo 3",
  addressPostalCode: "Indirizzo 4",
  addressCity: "Indirizzo 5",
  bookingEmail: "Dati di contatto 1",
  phone: "Dati di contatto 2",
  paymentMoney: "Forma di pagamento preferita 1",
  paymentVoucher: "Forma di pagamento preferita 2",
  iban: "Estremi del pagamento 1",
  swift: "Estremi del pagamento 2",
  otherPayment: "Estremi del pagamento 3",
  paymentHolder: "Estremi del pagamento 4",
  extraInfo: "Informazioni supplementari 1",
  gdprYes: "Regolamento generale sulla protezione dei dati 1",
  gdprNo: "Regolamento generale sulla protezione dei dati 2",
  requestDate: "Informazioni 1",
  requestPlace: "Informazioni 2",
  signature: "Informazioni 3",
} as const;

function setCheckbox(form: PDFForm, name: string, checked: boolean) {
  const checkbox = form.getCheckBox(name);
  if (!checked) {
    checkbox.uncheck();
    return;
  }

  const onValue = checkbox.acroField.getWidgets()[0]?.getOnValue();
  if (!onValue) throw new Error(`EU form checkbox has no appearance on value: ${name}`);
  checkbox.acroField.setValue(onValue);
}

function setText(form: PDFForm, name: string, value?: string) {
  form.getTextField(name).setText(value ?? "");
}

/** Fill the official Spanish EU rail claim form by stable PDF field name. */
export async function buildEuForm(input: EuFormDataType): Promise<Uint8Array> {
  const data = EuFormData.parse(input);
  const template = await readFile(TEMPLATE_PATH);
  const pdf = await PDFDocument.load(template);
  const form = pdf.getForm();

  setCheckbox(form, fields.reasonDelay, true);
  setCheckbox(form, fields.reasonCancellation, false);
  setCheckbox(form, fields.reasonMissedConnection, false);

  setText(form, fields.previousClaimDate, data.previousClaim?.date);
  setText(form, fields.previousClaimRecipient, data.previousClaim?.recipient);
  setText(form, fields.previousClaimMeans, data.previousClaim?.means);
  setText(form, fields.operator, data.operatorName);
  setText(form, fields.scheduledDate, data.scheduled.date);
  setText(form, fields.scheduledOrigin, data.scheduled.origin);
  setText(form, fields.scheduledDestination, data.scheduled.destination);
  setText(form, fields.scheduledDeparture, data.scheduled.departureTime);
  setText(form, fields.scheduledArrival, data.scheduled.arrivalTime);
  setText(form, fields.scheduledTrain, data.scheduled.trainNumber);
  setText(form, fields.ticketReference, data.scheduled.ticketRef);
  setText(form, fields.ticketPrice, data.scheduled.price);
  setText(form, fields.actualArrivalDate, data.actual.arrivalDate);
  setText(form, fields.actualDeparture, data.actual.departureTime);
  setText(form, fields.actualArrival, data.actual.arrivalTime);
  setText(form, fields.actualTrain, data.actual.trainNumber);
  setText(form, fields.missedConnection);

  setCheckbox(form, fields.requestRefund, false);
  setCheckbox(form, fields.requestCompensation, true);
  setCheckbox(form, fields.tier60To119, data.delayMinutes >= 60 && data.delayMinutes < 120);
  setCheckbox(form, fields.tier120Plus, data.delayMinutes >= 120);
  setCheckbox(form, fields.tierRecurring, false);
  setCheckbox(form, fields.requestCosts, false);

  setText(form, fields.firstName, data.passenger.firstName);
  setText(form, fields.lastName, data.passenger.lastName);
  setText(form, fields.addressStreet, data.address?.street);
  setText(form, fields.addressNumber, data.address?.number);
  setText(form, fields.addressCountry, data.address?.country);
  setText(form, fields.addressPostalCode, data.address?.postalCode);
  setText(form, fields.addressCity, data.address?.city);
  setText(form, fields.bookingEmail, data.bookingEmail);
  setText(form, fields.phone, data.phone);

  setCheckbox(form, fields.paymentMoney, data.paymentPreference === "money");
  setCheckbox(form, fields.paymentVoucher, data.paymentPreference === "voucher");
  setText(form, fields.iban, data.paymentDetails?.iban);
  setText(form, fields.swift, data.paymentDetails?.swift);
  setText(form, fields.otherPayment, data.paymentDetails?.other);
  setText(form, fields.paymentHolder, data.paymentDetails?.holder);
  setText(form, fields.extraInfo, data.extraInfo);

  setCheckbox(form, fields.gdprYes, data.gdprAccepted);
  setCheckbox(form, fields.gdprNo, !data.gdprAccepted);
  setText(form, fields.requestDate, data.request.date);
  setText(form, fields.requestPlace, data.request.place);
  setText(form, fields.signature, `Retren, en representación de ${data.representedName}`);

  form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
  return pdf.save({ updateFieldAppearances: false });
}
