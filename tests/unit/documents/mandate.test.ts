import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { buildMandate } from "@/features/documents/mandate";
import type { MandateData } from "@/shared/contracts";

const validMandate: MandateData = {
  caseRef: "RTN-B5TEST",
  passengerName: "Persona de Prueba",
  documentType: "passport",
  documentNumber: "SYNTHETIC-0001",
  operatorName: "Iryo",
  trip: {
    date: "2026-11-12",
    origin: "Origen de prueba",
    destination: "Destino de prueba",
    ticketRef: "SYNTHETIC-TICKET-01",
  },
  acceptedAt: "2026-11-14T09:30:00+01:00",
  consentTextVersion: "consent-draft-3",
};

async function extractText(bytes: Uint8Array): Promise<string> {
  const document = await getDocument({ data: Uint8Array.from(bytes) }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .filter((item): item is (typeof content.items)[number] & { str: string } => "str" in item)
        .map((item) => item.str)
        .join(" "),
    );
  }

  await document.cleanup();
  return pages.join(" ").replaceAll(/\s+/g, " ").trim();
}

async function expectTextWithinMargins(bytes: Uint8Array): Promise<void> {
  const document = await getDocument({ data: Uint8Array.from(bytes) }).promise;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageWidth = page.getViewport({ scale: 1 }).width;
    for (const item of content.items) {
      if ("str" in item && item.str !== "") {
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(pageWidth - 55);
      }
    }
  }

  await document.cleanup();
}

describe("buildMandate", () => {
  it("generates a valid PDF containing every required clause and all case data", async () => {
    const bytes = await buildMandate(validMandate);
    const text = await extractText(bytes);

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(text).toContain("BORRADOR PENDIENTE DE REVISIÓN JURÍDICA");
    expect(text).toContain("presentar la reclamación");
    expect(text).toContain("realizar insistencias");
    expect(text).toContain("escalar la reclamación");
    expect(text).toContain("no autoriza a aceptar condiciones distintas");
    expect(text).toContain("Tampoco autoriza a cobrar ni recibir dinero");
    expect(text).toContain("vigencia hasta el resultado definitivo");
    expect(text).toContain("revocar este mandato en cualquier momento");

    for (const value of [
      validMandate.caseRef,
      validMandate.passengerName,
      validMandate.documentType,
      validMandate.documentNumber,
      validMandate.operatorName,
      validMandate.trip.date,
      validMandate.trip.origin,
      validMandate.trip.destination,
      validMandate.trip.ticketRef,
      validMandate.acceptedAt,
      validMandate.consentTextVersion,
    ]) {
      expect(text).toContain(value);
    }
  });

  it("rejects missing required data", async () => {
    const invalid = { ...validMandate, documentNumber: "" } as MandateData;

    await expect(buildMandate(invalid)).rejects.toThrow();
  });

  it("stamps the mandate template version", async () => {
    const text = await extractText(await buildMandate(validMandate));

    expect(text).toContain("Versión del mandato: mandate-draft-2026-11-14");
    expect(text).toContain("Versión del consentimiento: consent-draft-3");
  });

  it("preserves European names outside WinAnsi", async () => {
    const passengerName = "Łukasz Żółć";
    const text = await extractText(await buildMandate({ ...validMandate, passengerName }));

    expect(text).toContain(passengerName);
  });

  it("wraps long identifiers inside the page margins", async () => {
    const documentNumber = `SYNTHETIC-${"X".repeat(240)}`;
    const bytes = await buildMandate({ ...validMandate, documentNumber });

    await expectTextWithinMargins(bytes);
    expect((await extractText(bytes)).replaceAll(" ", "")).toContain(documentNumber);
  });
});
