import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { MandateData, type MandateData as MandateDataType } from "@/shared/contracts";

const MANDATE_TEMPLATE_VERSION = "mandate-draft-2026-11-14";
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 15;
const require = createRequire(import.meta.url);
const REGULAR_FONT_PATH = require.resolve("next/dist/compiled/@vercel/og/Geist-Regular.ttf");
const BOLD_FONT_PATH = REGULAR_FONT_PATH;
const fontBytes = Promise.all([readFile(REGULAR_FONT_PATH), readFile(BOLD_FONT_PATH)]);

type WriterState = {
  document: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
};

function addPage(state: WriterState): void {
  state.page = state.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  state.y = PAGE_HEIGHT - MARGIN;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of paragraph.split(" ")) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        current = candidate;
      } else {
        if (current !== "") lines.push(current);
        const chunks: string[] = [];
        let chunk = "";
        for (const character of word) {
          const next = `${chunk}${character}`;
          if (chunk !== "" && font.widthOfTextAtSize(next, size) > width) {
            chunks.push(chunk);
            chunk = character;
          } else {
            chunk = next;
          }
        }
        lines.push(...chunks);
        current = chunk;
      }
    }
    if (current !== "") lines.push(current);
  }

  return lines;
}

function write(
  state: WriterState,
  text: string,
  options: { bold?: boolean; size?: number; gapAfter?: number } = {},
): void {
  const font = options.bold ? state.bold : state.font;
  const size = options.size ?? BODY_SIZE;
  const lineHeight = size + 4.5;

  for (const line of wrap(text, font, size, PAGE_WIDTH - MARGIN * 2)) {
    if (state.y < MARGIN + lineHeight) addPage(state);
    if (line !== "") {
      state.page.drawText(line, {
        x: MARGIN,
        y: state.y,
        size,
        font,
        color: rgb(0.08, 0.08, 0.08),
      });
    }
    state.y -= line === "" ? LINE_HEIGHT / 2 : lineHeight;
  }
  state.y -= options.gapAfter ?? 7;
}

/** Build the signed-at-consent representation mandate attached to an operator claim. */
export async function buildMandate(data: MandateDataType): Promise<Uint8Array> {
  const mandate = MandateData.parse(data);
  const document = await PDFDocument.create();
  const acceptedAt = new Date(mandate.acceptedAt);

  document.setTitle(`Mandato de representación ${mandate.caseRef}`);
  document.setAuthor("Retren");
  document.setSubject(`Mandato ${MANDATE_TEMPLATE_VERSION}`);
  document.setCreator("Retren");
  document.setProducer("Retren");
  document.setCreationDate(acceptedAt);
  document.setModificationDate(acceptedAt);

  document.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await fontBytes;
  const font = await document.embedFont(regularBytes, { subset: true });
  const bold = await document.embedFont(boldBytes, { subset: true });
  const state: WriterState = {
    document,
    page: document.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    font,
    bold,
    y: PAGE_HEIGHT - MARGIN,
  };

  write(state, "MANDATO DE REPRESENTACIÓN", { bold: true, size: 16, gapAfter: 4 });
  write(state, "BORRADOR PENDIENTE DE REVISIÓN JURÍDICA", {
    bold: true,
    size: 9,
    gapAfter: 14,
  });

  write(state, `Referencia del caso: ${mandate.caseRef}`);
  write(state, `Persona representada: ${mandate.passengerName}`);
  write(state, `Documento: ${mandate.documentType} ${mandate.documentNumber}`, { gapAfter: 14 });

  write(
    state,
    `${mandate.passengerName} otorga a Retren un mandato limitado para presentar la reclamación, realizar insistencias y escalar la reclamación ante ${mandate.operatorName} en relación con el viaje descrito en este documento.`,
  );
  write(
    state,
    "Este mandato no autoriza a aceptar condiciones distintas de las solicitadas por la persona representada, ni a renunciar a derechos. Tampoco autoriza a cobrar ni recibir dinero, reembolsos, vales o indemnizaciones en su nombre.",
  );
  write(
    state,
    "El mandato tendrá vigencia hasta el resultado definitivo de esta reclamación. La persona representada podrá revocar este mandato en cualquier momento mediante comunicación escrita; la revocación no afectará a las actuaciones ya realizadas.",
    { gapAfter: 14 },
  );

  write(state, "DATOS DEL VIAJE", { bold: true, size: 12 });
  write(state, `Operador: ${mandate.operatorName}`);
  write(state, `Fecha del viaje: ${mandate.trip.date}`);
  write(state, `Origen: ${mandate.trip.origin}`);
  write(state, `Destino: ${mandate.trip.destination}`);
  write(state, `Referencia del billete: ${mandate.trip.ticketRef}`, { gapAfter: 14 });

  write(state, "ACEPTACIÓN", { bold: true, size: 12 });
  write(state, `Fecha y hora de aceptación: ${mandate.acceptedAt}`);
  write(state, `Versión del mandato: ${MANDATE_TEMPLATE_VERSION}`);
  write(state, `Versión del consentimiento: ${mandate.consentTextVersion}`);

  return document.save({ useObjectStreams: false });
}
