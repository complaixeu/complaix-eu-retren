import { describe, expect, it } from "vitest";
import { formatFileSize, ticketChoiceError } from "@/app/(intake)/reclamar/foto/ticket-choice";
import { readTicketUpload } from "@/features/intake/upload/read";
import {
  TICKET_MAX_BYTES,
  TICKET_TYPES,
  TICKET_UPLOAD_ERRORS,
  detectTicketType,
  ticketUploadRules,
  validateTicket,
} from "@/features/intake/upload/rules";
import {
  PLACEHOLDER_AVIF,
  PLACEHOLDER_GIF,
  PLACEHOLDER_HEIC,
  PLACEHOLDER_HEIF_MIF1,
  PLACEHOLDER_JPEG,
  PLACEHOLDER_PDF,
  PLACEHOLDER_PNG,
  PLACEHOLDER_TEXT,
  placeholderPngOfSize,
} from "@/tests/fixtures/intake/tickets";

// [A1] Ticket upload: the type comes from the file's first bytes, never from its name or the
// MIME type the browser claims, and the size limit is 10 MB.

describe("detectTicketType (magic bytes)", () => {
  it.each([
    ["jpeg", PLACEHOLDER_JPEG],
    ["png", PLACEHOLDER_PNG],
    ["pdf", PLACEHOLDER_PDF],
    ["heic", PLACEHOLDER_HEIC],
    ["heic", PLACEHOLDER_HEIF_MIF1],
  ] as const)("recognises %s", (type, bytes) => {
    expect(detectTicketType(bytes)).toBe(type);
  });

  it.each([
    ["plain text", PLACEHOLDER_TEXT],
    ["a GIF", PLACEHOLDER_GIF],
    ["an AVIF (HEIF-shaped, not HEIC)", PLACEHOLDER_AVIF],
    ["nothing", new Uint8Array()],
    ["a truncated PNG signature", PLACEHOLDER_PNG.subarray(0, 4)],
    ["a truncated ftyp box", PLACEHOLDER_HEIC.subarray(0, 10)],
  ])("rejects %s", (_name, bytes) => {
    expect(detectTicketType(bytes)).toBeNull();
  });

  it("maps every type to the stored content type and extension", () => {
    expect(TICKET_TYPES).toEqual({
      jpeg: { contentType: "image/jpeg", extension: "jpg", label: "JPG", previewable: true },
      png: { contentType: "image/png", extension: "png", label: "PNG", previewable: true },
      heic: { contentType: "image/heic", extension: "heic", label: "HEIC", previewable: false },
      pdf: { contentType: "application/pdf", extension: "pdf", label: "PDF", previewable: false },
    });
  });
});

describe("validateTicket (type and size)", () => {
  it("accepts a file of exactly 10 MB", () => {
    expect(TICKET_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(validateTicket({ size: TICKET_MAX_BYTES, head: PLACEHOLDER_PNG })).toEqual({
      ok: true,
      type: "png",
    });
  });

  it("rejects one byte over 10 MB", () => {
    expect(validateTicket({ size: TICKET_MAX_BYTES + 1, head: PLACEHOLDER_PNG })).toEqual({
      ok: false,
      error: "too_large",
    });
  });

  it("rejects an empty file and no file", () => {
    expect(validateTicket({ size: 0, head: new Uint8Array() })).toEqual({
      ok: false,
      error: "empty",
    });
    expect(validateTicket(null)).toEqual({ ok: false, error: "missing" });
  });

  it("rejects a wrong type", () => {
    expect(validateTicket({ size: PLACEHOLDER_TEXT.length, head: PLACEHOLDER_TEXT })).toEqual({
      ok: false,
      error: "wrong_type",
    });
  });
});

describe("readTicketUpload (the server check on the submitted form value)", () => {
  const file = (bytes: Uint8Array, name: string, type = "") =>
    new File([Buffer.from(bytes)], name, { type });

  it("reads a valid file into the bytes, detected type and a clean file name", async () => {
    const out = await readTicketUpload(
      file(PLACEHOLDER_PDF, "  mi billete.pdf ", "application/pdf"),
    );
    expect(out).toEqual({
      ok: true,
      ticket: { bytes: PLACEHOLDER_PDF, type: "pdf", filename: "mi billete.pdf" },
    });
  });

  it("trusts the bytes, not the claimed MIME type or the extension", async () => {
    const lying = await readTicketUpload(file(PLACEHOLDER_TEXT, "billete.jpg", "image/jpeg"));
    expect(lying).toEqual({ ok: false, error: "wrong_type" });

    const renamed = await readTicketUpload(file(PLACEHOLDER_JPEG, "billete.png", "image/png"));
    expect(renamed).toMatchObject({ ok: true, ticket: { type: "jpeg" } });
  });

  it("rejects an oversize file on the server", async () => {
    const big = file(placeholderPngOfSize(TICKET_MAX_BYTES + 1), "grande.png", "image/png");
    expect(await readTicketUpload(big)).toEqual({ ok: false, error: "too_large" });
  });

  it("rejects a missing file, an empty one and a plain form field", async () => {
    expect(await readTicketUpload(null)).toEqual({ ok: false, error: "missing" });
    expect(await readTicketUpload("billete.png")).toEqual({ ok: false, error: "missing" });
    // A form with an empty file input sends a nameless, empty file.
    expect(await readTicketUpload(file(new Uint8Array(), ""))).toEqual({
      ok: false,
      error: "missing",
    });
    expect(await readTicketUpload(file(new Uint8Array(), "vacio.png"))).toEqual({
      ok: false,
      error: "empty",
    });
  });

  it("keeps the file name short and free of paths and control characters", async () => {
    const out = await readTicketUpload(
      file(PLACEHOLDER_PNG, `C:\\fotos\\..\\bil\u0000lete${"x".repeat(200)}.png`),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ticket.filename).not.toMatch(/[\\/\u0000-\u001f]/);
    expect(out.ticket.filename.length).toBeLessThanOrEqual(120);
    expect(out.ticket.filename.startsWith("billete")).toBe(true);
  });
});

describe("upload messages", () => {
  it("say what happened and what to do next, in Spanish", () => {
    expect(Object.keys(TICKET_UPLOAD_ERRORS).sort()).toEqual(
      ["empty", "failed", "missing", "too_large", "wrong_type"].sort(),
    );
    for (const message of Object.values(TICKET_UPLOAD_ERRORS)) {
      expect(message).toMatch(/\.$/);
      expect(message).not.toMatch(/[!¡]/);
    }
    expect(TICKET_UPLOAD_ERRORS.too_large).toContain("10 MB");
    expect(TICKET_UPLOAD_ERRORS.wrong_type).toMatch(/JPG|PNG|HEIC|PDF/);
  });
});

describe("ticketChoiceError (the instant check in the browser, before uploading)", () => {
  const choice = (name: string, size: number, type = "") => ({ name, size, type });

  it("passes the accepted types by extension or by MIME type", () => {
    for (const name of ["a.jpg", "a.JPEG", "a.png", "a.heic", "a.HEIF", "a.pdf"]) {
      expect(ticketChoiceError(choice(name, 100), ticketUploadRules)).toBeNull();
    }
    expect(ticketChoiceError(choice("foto", 100, "image/jpeg"), ticketUploadRules)).toBeNull();
  });

  it("catches a wrong type, an oversize, an empty and a missing file", () => {
    expect(ticketChoiceError(choice("a.txt", 100, "text/plain"), ticketUploadRules)).toBe(
      "wrong_type",
    );
    expect(ticketChoiceError(choice("a.gif", 100, "image/gif"), ticketUploadRules)).toBe(
      "wrong_type",
    );
    expect(ticketChoiceError(choice("a.png", TICKET_MAX_BYTES + 1), ticketUploadRules)).toBe(
      "too_large",
    );
    expect(ticketChoiceError(choice("a.png", 0), ticketUploadRules)).toBe("empty");
    expect(ticketChoiceError(null, ticketUploadRules)).toBe("missing");
  });

  it("gets the same limit and types the server checks", () => {
    expect(ticketUploadRules.maxBytes).toBe(TICKET_MAX_BYTES);
    expect(ticketUploadRules.messages).toEqual(TICKET_UPLOAD_ERRORS);
    for (const t of Object.values(TICKET_TYPES)) {
      expect(ticketUploadRules.mimeTypes).toContain(t.contentType);
      expect(ticketUploadRules.extensions).toContain(t.extension);
      expect(ticketUploadRules.accept).toContain(`.${t.extension}`);
    }
  });
});

describe("formatFileSize", () => {
  it("writes sizes the Spanish way", () => {
    expect(formatFileSize(900)).toBe("1 KB");
    expect(formatFileSize(250 * 1024)).toBe("250 KB");
    expect(formatFileSize(1.25 * 1024 * 1024)).toBe("1,3 MB");
    expect(formatFileSize(TICKET_MAX_BYTES)).toBe("10 MB");
  });
});
