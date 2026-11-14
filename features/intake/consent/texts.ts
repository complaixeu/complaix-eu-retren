/**
 * The texts the user accepts on the authorization step ([A6]): the representation mandate and
 * the privacy notice. Versioned: a consent row stores `CONSENT_TEXT_VERSION`, so any change to
 * the wording below (checkbox labels included) needs a new version string.
 *
 * Draft, pending legal review (ARCHITECTURE "Aspectos legales y privacidad"). The content only
 * restates what ARCHITECTURE decides and what the mandate PDF ([B5]) already says; it adds no
 * legal claims of its own.
 */
export const CONSENT_TEXT_VERSION = "mandato-2026-11-14-borrador";

export const CONSENT_DRAFT_NOTICE = {
  title: "Borrador pendiente de revisión jurídica",
  text: "Un abogado todavía tiene que revisar estos textos. Pueden cambiar antes del lanzamiento.",
} as const;

export interface MandateText {
  title: string;
  intro: string;
  may: { title: string; items: readonly string[] };
  mayNot: { title: string; items: readonly string[] };
  terms: readonly string[];
}

export const MANDATE_TEXT: MandateText = {
  title: "Autorización de representación",
  intro:
    "Autorizas a ReTren a reclamar en tu nombre, ante la compañía de tren, la indemnización por el retraso del viaje que ves más abajo.",
  may: {
    title: "ReTren puede",
    items: [
      "Presentar la reclamación por correo, con el formulario europeo, esta autorización y tu billete.",
      "Insistir si la compañía no responde o deniega la reclamación.",
      "Escalar la reclamación a la DGTT o a la Junta Arbitral de Transporte si hace falta.",
    ],
  },
  mayNot: {
    title: "ReTren no puede",
    items: [
      "Aceptar en tu nombre condiciones distintas de las que pides, ni renunciar a tus derechos.",
      "Cobrar ni recibir dinero o vales en tu nombre: la compañía te paga a ti directamente.",
    ],
  },
  terms: [
    "ReTren firma cada correo como «ReTren, en representación de» tu nombre. No se hace pasar por ti.",
    "La autorización dura hasta que la reclamación tenga un resultado definitivo.",
    "Puedes retirarla cuando quieras, por escrito. Lo que ReTren ya haya hecho hasta entonces sigue siendo válido.",
    "Gratis: en esta fase ReTren no te cobra nada por reclamar.",
  ],
};

export interface PrivacyNotice {
  title: string;
  items: readonly { term: string; text: string }[];
}

export const PRIVACY_NOTICE: PrivacyNotice = {
  title: "Aviso de privacidad",
  items: [
    {
      term: "Qué datos",
      text: "La foto o el PDF del billete y lo que leemos en él, tu documento de identidad, tu email y tus respuestas sobre el viaje. Al aceptar guardamos además, como prueba, la fecha y la hora, la versión de este texto, tu dirección IP y los datos del viaje.",
    },
    {
      term: "Para qué",
      text: "Solo para preparar, enviar y seguir tu reclamación. Tu email sirve para pedirte un documento que solo tú tienes o para contarte el resultado, nada más.",
    },
    {
      term: "Quién los recibe",
      text: "La compañía de tren recibe la reclamación, esta autorización y tu billete. Para leer el billete usamos Google Cloud Vision y Gemini.",
    },
    {
      term: "Cuánto tiempo",
      text: "Pedimos lo mínimo y lo borramos en cuanto deja de hacer falta. Una reclamación sin terminar caduca a las 24 horas.",
    },
    {
      term: "Tus derechos",
      text: "Puedes pedir ver los datos que tenemos de ti y que los borremos.",
    },
  ],
};

/** The two checkboxes: separate, because the mandate and the privacy consent are separate. */
export const CONSENT_CHOICES = {
  mandate: {
    label: "Autorizo a ReTren a reclamar en mi nombre en estas condiciones",
    error: "Marca la autorización: sin ella no podemos reclamar por ti.",
  },
  privacy: {
    label:
      "He leído el aviso de privacidad y acepto que ReTren trate mis datos para esta reclamación.",
    error: "Marca la aceptación del aviso de privacidad para seguir.",
  },
} as const;

export type ConsentChoice = keyof typeof CONSENT_CHOICES;
