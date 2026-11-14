import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PDFBool, PDFCheckBox, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildEuForm } from "@/features/documents/eu-form";
import type { EuFormData } from "@/shared/contracts";
import { fullEuFormData, minimalEuFormData } from "@/tests/fixtures/documents/eu-form";

const templatePath = path.join(process.cwd(), "templates/formulario_ue_es.pdf");

const checkboxNames = [
  "Motivi della richiesta 1",
  "Motivi della richiesta 2",
  "Motivi della richiesta 3",
  "Specificare la richiesta/le richieste 1",
  "Specificare la richiesta/le richieste 2",
  "Selezionare una delle 3 opzioni 1",
  "Selezionare una delle 3 opzioni 2",
  "Selezionare una delle 3 opzioni 3",
  "Specificare la richiesta/le richieste 3",
  "Forma di pagamento preferita 1",
  "Forma di pagamento preferita 2",
  "Regolamento generale sulla protezione dei dati 1",
  "Regolamento generale sulla protezione dei dati 2",
] as const;

const fullTextValues: Record<string, string> = {
  "Data 1": "2026-10-01",
  "Destinatario della richiesta 1": "OPERADOR SINTÉTICO",
  "Richiesta precedente 1": "CANAL SINTÉTICO",
  "Nome dell'impresa ferroviaria 1": "OPERADOR SINTÉTICO",
  "Viaggio previsto 1": "2026-10-02",
  "Viaggio previsto 2": "ORIGEN SINTÉTICO",
  "Viaggio previsto 3": "DESTINO SINTÉTICO",
  "Viaggio previsto 4": "08:00",
  "Scheduled journey 5": "09:00",
  "Viaggio previsto 6": "TREN-SINTÉTICO",
  "Viaggio previsto 7": "BILLETE-SINTÉTICO",
  "Viaggio previsto 8": "10,00 EUR",
  "Viaggio effettivo 1": "2026-10-02",
  "Viaggio effettivo 2": "08:05",
  "Viaggio effettivo 3": "10:01",
  "Viaggio effettivo 4": "TREN-REAL-SINTÉTICO",
  "Viaggio effettivo 5": "",
  "Nome 1": "NOMBRE SINTÉTICO",
  "Nome 2": "APELLIDOS SINTÉTICOS",
  "Indirizzo 1": "CALLE SINTÉTICA",
  "Indirizzo 2": "NÚMERO SINTÉTICO",
  "Indirizzo 3": "PAÍS SINTÉTICO",
  "Indirizzo 4": "CP-SINTÉTICO",
  "Indirizzo 5": "MUNICIPIO SINTÉTICO",
  "Dati di contatto 1": "synthetic@example.invalid",
  "Dati di contatto 2": "TELÉFONO-SINTÉTICO",
  "Estremi del pagamento 1": "IBAN-SINTÉTICO",
  "Estremi del pagamento 2": "SWIFT-SINTÉTICO",
  "Estremi del pagamento 3": "MEDIO-PAGO-SINTÉTICO",
  "Estremi del pagamento 4": "TITULAR SINTÉTICO",
  "Informazioni supplementari 1": "INFORMACIÓN SINTÉTICA",
  "Informazioni 1": "2026-10-03",
  "Informazioni 2": "LUGAR SINTÉTICO",
  "Informazioni 3": "Retren, en representación de PERSONA REPRESENTADA SINTÉTICA",
};

const expectedFullChecked = new Set([
  "Motivi della richiesta 1",
  "Specificare la richiesta/le richieste 2",
  "Selezionare una delle 3 opzioni 1",
  "Forma di pagamento preferita 1",
  "Regolamento generale sulla protezione dei dati 1",
]);

async function openOutput(data: EuFormData = fullEuFormData) {
  return PDFDocument.load(await buildEuForm(data));
}

function checkboxValue(field: PDFCheckBox) {
  return field.acroField.getValue().toString();
}

function checkboxOnValue(field: PDFCheckBox) {
  const onValue = field.acroField.getWidgets()[0]?.getOnValue();
  if (!onValue) throw new Error(`Checkbox ${field.getName()} has no on value`);
  return onValue.toString();
}

describe("buildEuForm", () => {
  it("fills every one of the 47 mapped fields by its constant name", async () => {
    const pdf = await openOutput();
    const form = pdf.getForm();

    expect(form.getFields()).toHaveLength(47);
    expect(Object.keys(fullTextValues)).toHaveLength(34);
    expect(checkboxNames).toHaveLength(13);

    for (const [name, expected] of Object.entries(fullTextValues)) {
      expect(form.getTextField(name).getText() ?? "", name).toBe(expected);
    }

    for (const name of checkboxNames) {
      const expected = expectedFullChecked.has(name)
        ? checkboxOnValue(form.getCheckBox(name))
        : PDFName.of("Off").toString();
      expect(checkboxValue(form.getCheckBox(name)), name).toBe(expected);
    }
  });

  it("leaves optional personal and payment data blank when it was not supplied", async () => {
    const pdf = await openOutput(minimalEuFormData);
    const form = pdf.getForm();
    const blankFields = [
      "Data 1",
      "Destinatario della richiesta 1",
      "Richiesta precedente 1",
      "Viaggio previsto 6",
      "Viaggio previsto 8",
      "Viaggio effettivo 2",
      "Viaggio effettivo 4",
      "Viaggio effettivo 5",
      "Indirizzo 1",
      "Indirizzo 2",
      "Indirizzo 3",
      "Indirizzo 4",
      "Indirizzo 5",
      "Dati di contatto 1",
      "Dati di contatto 2",
      "Estremi del pagamento 1",
      "Estremi del pagamento 2",
      "Estremi del pagamento 3",
      "Estremi del pagamento 4",
      "Informazioni supplementari 1",
    ];

    for (const name of blankFields) {
      expect(form.getTextField(name).getText() ?? "", name).toBe("");
    }
  });

  it("uses each checkbox on value from its own appearance dictionary", async () => {
    const template = await PDFDocument.load(await readFile(templatePath));
    const output = await openOutput();

    for (const name of checkboxNames) {
      const templateField = template.getForm().getCheckBox(name);
      const outputField = output.getForm().getCheckBox(name);
      const expected = expectedFullChecked.has(name)
        ? checkboxOnValue(templateField)
        : PDFName.of("Off").toString();
      expect(checkboxValue(outputField), name).toBe(expected);
    }
  });

  it.each([
    { delayMinutes: 59, first: false, second: false },
    { delayMinutes: 60, first: true, second: false },
    { delayMinutes: 119, first: true, second: false },
    { delayMinutes: 120, first: false, second: true },
  ])(
    "selects the correct compensation tier at $delayMinutes minutes",
    async ({ delayMinutes, first, second }) => {
      const pdf = await openOutput({ ...minimalEuFormData, delayMinutes });
      const form = pdf.getForm();

      expect(form.getCheckBox("Selezionare una delle 3 opzioni 1").isChecked()).toBe(first);
      expect(form.getCheckBox("Selezionare una delle 3 opzioni 2").isChecked()).toBe(second);
      expect(form.getCheckBox("Selezionare una delle 3 opzioni 3").isChecked()).toBe(false);
    },
  );

  it("checks GDPR no when consent was not accepted", async () => {
    const pdf = await openOutput(minimalEuFormData);
    const form = pdf.getForm();

    expect(form.getCheckBox("Regolamento generale sulla protezione dei dati 1").isChecked()).toBe(
      false,
    );
    const no = form.getCheckBox("Regolamento generale sulla protezione dei dati 2");
    expect(checkboxValue(no)).toBe(checkboxOnValue(no));
  });

  it("does not modify the checked-in template", async () => {
    const before = createHash("sha256")
      .update(await readFile(templatePath))
      .digest("hex");
    await buildEuForm(fullEuFormData);
    const after = createHash("sha256")
      .update(await readFile(templatePath))
      .digest("hex");

    expect(after).toBe(before);
  });

  it("returns a valid PDF with NeedAppearances enabled", async () => {
    const pdf = await openOutput();
    const needAppearances = pdf
      .getForm()
      .acroForm.dict.lookup(PDFName.of("NeedAppearances"), PDFBool);

    expect(needAppearances.asBoolean()).toBe(true);
  });

  it("keeps fixtures synthetic and never stores a filled PDF in the repository", async () => {
    const fixturesPath = path.join(process.cwd(), "tests/fixtures/documents");
    const fixtureFiles = await readdir(fixturesPath);

    expect(JSON.stringify([fullEuFormData, minimalEuFormData])).not.toMatch(
      /RENFE|IRYO|OUIGO|[A-Z]{2}\d{22}/i,
    );
    expect(fixtureFiles.some((file) => file.toLowerCase().endsWith(".pdf"))).toBe(false);
  });
});
