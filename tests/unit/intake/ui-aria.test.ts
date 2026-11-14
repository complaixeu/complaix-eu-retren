import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button,
  Checkbox,
  Field,
  Fieldset,
  FileInput,
  Input,
  Radio,
  focusFirstInvalid,
} from "@/shared/ui";

// The ARIA wiring of the shared form components, rendered to HTML (no browser needed).
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

/** Attributes of the first element matching `tag` that carries `id="<id>"`. */
function attrsOf(markup: string, id: string): Record<string, string> {
  const tag = new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`).exec(markup)?.[0];
  if (!tag) throw new Error(`no element with id ${id} in ${markup}`);
  return Object.fromEntries([...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

describe("Field", () => {
  it("ties the label, error and help text to its control", () => {
    const out = html(
      h(Field, {
        id: "email",
        label: "Email",
        help: "Solo para avisos",
        error: "Escribe un email válido",
        children: (c) => h(Input, { ...c, type: "email" }),
      }),
    );
    expect(out).toContain('for="email"');
    expect(attrsOf(out, "email")).toMatchObject({
      "aria-describedby": "email-error email-help",
      "aria-invalid": "true",
    });
    expect(out).toContain('id="email-error"');
    expect(out).toContain('id="email-help"');
  });

  it("does not mark a control without an error as invalid", () => {
    const out = html(h(Field, { id: "nombre", label: "Nombre", children: (c) => h(Input, c) }));
    expect(attrsOf(out, "nombre")["aria-invalid"]).toBeUndefined();
    expect(attrsOf(out, "nombre")["aria-describedby"]).toBeUndefined();
  });

  it("works with the file input, which only accepts the listed types", () => {
    const out = html(
      h(Field, {
        id: "billete",
        label: "Foto o PDF del billete",
        help: "JPG, PNG, HEIC o PDF, hasta 10 MB",
        children: (c) => h(FileInput, { ...c, name: "ticket", accept: ".jpg,.png,.heic,.pdf" }),
      }),
    );
    expect(attrsOf(out, "billete")).toMatchObject({
      type: "file",
      accept: ".jpg,.png,.heic,.pdf",
      "aria-describedby": "billete-help",
    });
  });
});

describe("Fieldset", () => {
  it("has a legend and is described by its error and help text", () => {
    const out = html(
      h(Fieldset, {
        id: "pago",
        legend: "¿Cómo quieres cobrar?",
        help: "Algunas compañías solo pagan con vale",
        error: "Elige una opción",
        children: [
          h(Radio, { key: "d", id: "pago-dinero", name: "pago", value: "money", label: "Dinero" }),
          h(Radio, { key: "v", id: "pago-vale", name: "pago", value: "voucher", label: "Vale" }),
        ],
      }),
    );
    expect(out).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>¿Cómo quieres cobrar\?<\/legend>/);
    expect(attrsOf(out, "pago")).toMatchObject({
      "aria-describedby": "pago-error pago-help",
    });
    expect(out).toContain('for="pago-dinero"');
    expect(attrsOf(out, "pago-vale")).toMatchObject({ type: "radio", name: "pago" });
  });
});

describe("Checkbox", () => {
  it("is a labelled checkbox described by its help and error", () => {
    const out = html(
      h(Checkbox, {
        id: "rgpd",
        name: "rgpd",
        label: "Acepto el aviso de privacidad",
        help: "Puedes retirarlo cuando quieras",
        error: "Tienes que aceptarlo para continuar",
      }),
    );
    expect(out).toContain('for="rgpd"');
    expect(attrsOf(out, "rgpd")).toMatchObject({
      type: "checkbox",
      "aria-describedby": "rgpd-error rgpd-help",
      "aria-invalid": "true",
    });
  });
});

describe("Button", () => {
  it("keeps its label while pending, and is busy and disabled", () => {
    const out = html(h(Button, { id: "enviar", type: "submit", pending: true }, "Continuar"));
    expect(out).toContain(">Continuar</button>");
    expect(attrsOf(out, "enviar")).toMatchObject({ type: "submit", "aria-busy": "true" });
    expect(out).toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("is neither busy nor disabled by default", () => {
    const out = html(h(Button, { id: "seguir" }, "Seguir"));
    expect(attrsOf(out, "seguir")).toMatchObject({ type: "button" });
    expect(out).not.toContain("aria-busy");
    expect(out).not.toContain("disabled");
  });
});

describe("focusFirstInvalid", () => {
  it("focuses the first invalid control and reports whether there was one", () => {
    const focused: string[] = [];
    const control = { focus: () => focused.push("dni") };
    const root = {
      querySelector: (sel: string) => (sel === '[aria-invalid="true"]' ? control : null),
    };
    expect(focusFirstInvalid(root)).toBe(true);
    expect(focused).toEqual(["dni"]);
    expect(focusFirstInvalid({ querySelector: () => null })).toBe(false);
  });
});
