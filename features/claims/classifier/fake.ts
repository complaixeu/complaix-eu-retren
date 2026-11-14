import type { Classifier, ReplyCategory } from "@/shared/contracts";
import { normalize, stripQuoted } from "./guard";
import { OTHER, toVerdict } from "./verdict";

/**
 * The default classifier for tests, CI and the demo: deterministic keyword rules over the
 * Spanish replies of the golden set (tests/fixtures/mail/). No network, no model.
 *
 * A decision (asks for data, approved, denied, refers to the form) wins over an acknowledgement;
 * two different decisions, or nothing recognisable, give `other`.
 */

type Decisive = Exclude<ReplyCategory, "acknowledgement" | "other">;

const DECISIVE: Record<Decisive, RegExp[]> = {
  denied: [
    /\bdesestimad[ao]\b/,
    /\bdenegad[ao]\b/,
    /\brechazad[ao]\b/,
    /\bno procede\b/,
    /\bno cumpl(e|ir) (con )?los requisitos\b/,
  ],
  approved: [
    /\baprobad[ao]\b/,
    /\bhemos aprobado\b/,
    /(?<!\bno )\bprocede (el|la|al) (reembolso|abono|indemnizacion|compensacion)\b/,
    /\bse le abonara\b/,
    /\b(ha sido|queda) estimada\b/,
  ],
  asks_for_data: [
    /\biban\b/,
    /\bcertificado de titularidad\b/,
    /\bcopia del (dni|nie|pasaporte|documento)\b/,
    /\bdocumentacion adicional\b/,
    /\bnecesitamos que nos (facilite|envie|remita|indique)\b/,
    /\b(envie|adjunte|remita)n? (el|la|los|las|un|una)\b.{0,40}\b(documentos?|certificado|justificante|copia)\b/,
  ],
  refers_to_form: [
    /\bformulario (web|online|de reclamaciones)\b/,
    /\barea de cliente\b/,
    /\ba traves de (nuestra|la) (web|pagina)\b/,
  ],
};

const ACKNOWLEDGEMENT: RegExp[] = [
  /\bhemos recibido\b/,
  /\bacusamos recibo\b/,
  /\bnumero de (incidencia|expediente|referencia)\b/,
  /\bestamos (revisando|tramitando|estudiando)\b/,
  /\ble (responderemos|contestaremos)\b/,
];

export function fakeCategory(text: string): ReplyCategory {
  const t = normalize(text);
  const hits = (Object.keys(DECISIVE) as Decisive[]).filter((c) =>
    DECISIVE[c].some((re) => re.test(t)),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return "other";
  return ACKNOWLEDGEMENT.some((re) => re.test(t)) ? "acknowledgement" : "other";
}

export function createFakeClassifier(): Classifier {
  return {
    async classify(mail) {
      // Only the new part of the reply: quoted history is our own earlier text.
      const category = fakeCategory(`${mail.subject}\n${stripQuoted(mail.text)}`);
      return category === "other" ? { ...OTHER } : toVerdict({ category, confidence: 0.9 });
    },
  };
}
