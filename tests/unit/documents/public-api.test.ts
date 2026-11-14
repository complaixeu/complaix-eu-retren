import { describe, expect, it } from "vitest";
import { RenderedTemplate } from "@/shared/contracts";
import * as documents from "@/features/documents";
import * as mock from "@/features/documents/mock";
import { buildEuForm as realBuildEuForm } from "@/features/documents/eu-form";
import { buildMandate as realBuildMandate } from "@/features/documents/mandate";
import { renderTemplate as realRenderTemplate } from "@/features/documents/templates";

describe("documents public API", () => {
  it("routes the EU form and mandate exports to their real implementations", () => {
    expect(documents.buildEuForm).toBe(realBuildEuForm);
    expect(documents.buildMandate).toBe(realBuildMandate);
    expect(documents.renderTemplate).toBe(realRenderTemplate);
  });

  it("keeps the template mock output valid against the shared schema", () => {
    const rendered = mock.renderTemplate("initial_claim", "iryo", {
      ref: "RTN-B7TEST",
      passengerName: "Persona de prueba",
      documentNumber: "SYNTHETIC-0001",
    });

    expect(RenderedTemplate.safeParse(rendered).success).toBe(true);
    expect(rendered.subject).toContain("[RTN-B7TEST]");
  });
});
