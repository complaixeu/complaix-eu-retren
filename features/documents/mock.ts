// Mock of domain B (documents). Same exports and types as the real one.
import {
  RenderedTemplate,
  type EuFormData,
  type MandateData,
  type OperatorId,
  type TemplateKind,
} from "@/shared/contracts";

const pdfStub = (label: string) => new TextEncoder().encode(`%PDF-1.7\n% mock ${label}\n%%EOF\n`);

export async function buildEuForm(data: EuFormData): Promise<Uint8Array> {
  return pdfStub(`eu-form ${data.scheduled.ticketRef}`);
}

export async function buildMandate(data: MandateData): Promise<Uint8Array> {
  return pdfStub(`mandate ${data.caseRef}`);
}

export function renderTemplate(
  kind: TemplateKind,
  operator: OperatorId,
  vars: Record<string, string> & { ref: string },
): RenderedTemplate {
  return RenderedTemplate.parse({
    subject: `[${vars.ref}] ${kind} (${operator})`,
    text: `mock ${kind}\n\nRetren, en representación de ${vars.passengerName ?? "el viajero"}`,
  });
}
