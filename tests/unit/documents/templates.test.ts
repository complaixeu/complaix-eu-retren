import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/features/documents";
import { OperatorId, TemplateKind } from "@/shared/contracts";

const operators = OperatorId.options;
const kinds = TemplateKind.options;

const reference = "RTN-B6TEST01";
const fullVars: Record<string, string> & { ref: string } = {
  ref: reference,
  passengerName: "Lucía Ejemplo",
  documentType: "DNI",
  documentNumber: "SYNTHETIC-0001",
  travelDate: "2026-10-12",
  origin: "Madrid",
  destination: "Valencia",
  bookingRef: "RESERVA-123",
  ticketRef: "BILLETE-456",
  trainNumber: "TEST-07",
  delayMinutes: "95",
  paymentPreference: "dinero",
  sentDate: "2026-10-12",
  day: "45",
  reminderD12Date: "2026-10-24",
  reminderD30Date: "2026-11-11",
  lastNoticeD40Date: "2026-11-21",
  escalationD45Date: "2026-11-26",
  result: "approved",
  reason: "motivo de prueba",
  confirmReceipt: "yes",
  operatorText: "TEXTO PRIVADO DEL OPERADOR",
};
const operatorNames = { iryo: "Iryo", renfe: "Renfe", ouigo: "OUIGO" } as const;
const varsFor = (operator: (typeof operators)[number]) => ({
  ...fullVars,
  operatorName: operatorNames[operator],
});

describe("renderTemplate", () => {
  describe.each(kinds)("%s", (kind) => {
    it.each(operators)("renders the %s template snapshot with its case reference", (operator) => {
      const rendered = renderTemplate(kind, operator, varsFor(operator));

      expect(rendered.subject).toContain(`[${reference}]`);
      expect(rendered).toMatchSnapshot(`${kind} / ${operator}`);
    });
  });

  it("omits optional initial-claim details when a caller does not provide them", () => {
    const rendered = renderTemplate("initial_claim", "iryo", { ref: reference });
    expect(rendered.text).not.toContain("undefined");
    expect(rendered.text).not.toContain("documento:");
  });

  it("throws when the required case reference is missing", () => {
    const missingRef = { passengerName: "Lucía Ejemplo" } as unknown as Record<string, string> & {
      ref: string;
    };
    expect(() => renderTemplate("user_final_result", "iryo", missingRef)).toThrow(/ref/);
  });

  it("keeps reminder and escalation messages distinct and cites the earlier dates and legal basis", () => {
    const reminders = [
      "reminder_d12",
      "reminder_d30",
      "last_notice_d40",
      "escalation_d45",
    ] as const;
    const rendered = reminders.map((kind) => renderTemplate(kind, "iryo", varsFor("iryo")));

    expect(new Set(rendered.map((mail) => mail.text)).size).toBe(reminders.length);
    for (const mail of rendered) {
      expect(mail.text).toContain("2026-10-12");
      expect(mail.text).toContain("Reglamento (UE) 2021/782");
    }
    expect(rendered[1].text).toContain("2026-10-24");
    expect(rendered[2].text).toContain("2026-10-24");
    expect(rendered[2].text).toContain("2026-11-11");
    expect(rendered[3].text).toContain("2026-10-24");
    expect(rendered[3].text).toContain("2026-11-11");
    expect(rendered[3].text).toContain("2026-11-21");
  });

  it.each(kinds)("uses 3–4 non-empty lines and the representation signature for %s", (kind) => {
    const text = renderTemplate(kind, "iryo", varsFor("iryo")).text;
    const lines = text.split(/\r?\n/).filter((line) => line.trim());

    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.at(-1)).toBe("Retren, en representación de Lucía Ejemplo");
    expect(text).not.toMatch(/\b(?:soy|me llamo|en mi nombre|yo)\b/i);
  });

  it.each(["user_request_document", "user_final_result"] as const)(
    "does not include operator-supplied text in %s notices",
    (kind) => {
      const rendered = renderTemplate(kind, "iryo", varsFor("iryo"));
      expect(`${rendered.subject}\n${rendered.text}`).not.toContain(fullVars.operatorText);
    },
  );

  it.each([
    "insistence_after_denial",
    "reply_acknowledgement",
    "reply_asks_for_data",
    "reply_approved",
    "reply_denied",
    "reply_refers_to_form",
  ] as const)("includes the optional identity document in operator mail %s", (kind) => {
    expect(renderTemplate(kind, "iryo", varsFor("iryo")).text).toContain("SYNTHETIC-0001");
  });

  it("omits optional values rather than rendering undefined", () => {
    const rendered = renderTemplate("reply_asks_for_data", "iryo", { ref: reference });
    expect(rendered.text).not.toContain("undefined");
  });
});
