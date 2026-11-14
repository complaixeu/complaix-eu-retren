import { describe, expect, it } from "vitest";
import { clientIp } from "@/features/intake/consent/ip";
import { buildTripSnapshot, tripSummary } from "@/features/intake/consent/snapshot";
import {
  CONSENT_DRAFT_NOTICE,
  CONSENT_TEXT_VERSION,
  MANDATE_TEXT,
  PRIVACY_NOTICE,
} from "@/features/intake/consent/texts";
import { toConsentRef } from "@/features/intake/consent/store";
import { ConsentRef } from "@/shared/contracts";
import { ANSWERS, REVIEW, REVIEWED_TICKET } from "../../fixtures/intake/review";

// [A6] Pure parts of the consent step: the client IP from the request headers, the trip snapshot
// kept as evidence, and the versioned texts.

const headers = (values: Record<string, string>) => new Headers(values);

describe("clientIp", () => {
  it("takes the first hop of x-forwarded-for", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }))).toBe(
      "203.0.113.7",
    );
  });

  it("trims the first hop", () => {
    expect(clientIp(headers({ "x-forwarded-for": "  203.0.113.7  ,10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
  });

  it("prefers x-forwarded-for over x-real-ip", () => {
    expect(
      clientIp(headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.1" })),
    ).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(clientIp(headers({ "x-real-ip": "198.51.100.1" }))).toBe("198.51.100.1");
  });

  it("falls back to x-real-ip when the first hop is not an address", () => {
    expect(clientIp(headers({ "x-forwarded-for": "unknown", "x-real-ip": "198.51.100.1" }))).toBe(
      "198.51.100.1",
    );
  });

  it("is null without either header", () => {
    expect(clientIp(headers({}))).toBeNull();
  });

  it("is null when neither header holds an address", () => {
    expect(clientIp(headers({ "x-forwarded-for": "", "x-real-ip": "not-an-ip" }))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": "<script>", "x-real-ip": " " }))).toBeNull();
  });

  it("accepts IPv6, also in brackets with a port", () => {
    expect(clientIp(headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(headers({ "x-forwarded-for": "[2001:DB8::1]:443" }))).toBe("2001:db8::1");
  });

  it("drops the port of an IPv4 address", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7:51234" }))).toBe("203.0.113.7");
  });
});

describe("buildTripSnapshot", () => {
  it("copies the reviewed ticket", () => {
    expect(buildTripSnapshot({ review: REVIEW })).toEqual({
      ok: true,
      snapshot: { ticket: REVIEWED_TICKET },
    });
  });

  it("adds the answers when they are there", () => {
    expect(buildTripSnapshot({ review: REVIEW, answers: ANSWERS })).toEqual({
      ok: true,
      snapshot: { ticket: REVIEWED_TICKET, answers: ANSWERS },
    });
  });

  it("keeps only the ticket fields of the contract", () => {
    const result = buildTripSnapshot({
      review: { ...REVIEW, ticket: { ...REVIEWED_TICKET, injected: "x" } },
      extraction: { raw: "texto del OCR" },
    });
    expect(result).toEqual({ ok: true, snapshot: { ticket: REVIEWED_TICKET } });
  });

  it("needs a review", () => {
    expect(buildTripSnapshot({})).toEqual({ ok: false, reason: "review_missing" });
    expect(buildTripSnapshot({ review: null })).toEqual({ ok: false, reason: "review_missing" });
    expect(buildTripSnapshot({ review: { bookingRefConfirmed: true } })).toEqual({
      ok: false,
      reason: "review_missing",
    });
  });

  it("refuses a review whose ticket breaks the contract", () => {
    expect(
      buildTripSnapshot({ review: { ...REVIEW, ticket: { travelDate: "10/03/2026" } } }),
    ).toEqual({ ok: false, reason: "review_missing" });
  });

  it("refuses answers that break the contract", () => {
    expect(buildTripSnapshot({ review: REVIEW, answers: { email: "no" } })).toEqual({
      ok: false,
      reason: "answers_invalid",
    });
  });
});

describe("tripSummary", () => {
  it("lists what the user authorizes, in plain Spanish", () => {
    expect(tripSummary(REVIEWED_TICKET)).toEqual([
      { label: "Compañía", value: "Iryo" },
      { label: "Fecha", value: "10 de marzo de 2026" },
      { label: "Trayecto", value: "Estación Prueba Norte – Estación Prueba Sur" },
      { label: "Localizador", value: "TEST01" },
      { label: "Pasajero", value: "Persona De Prueba" },
    ]);
  });

  it("leaves out what is missing", () => {
    expect(tripSummary({ bookingRef: "TEST01" })).toEqual([
      { label: "Localizador", value: "TEST01" },
    ]);
  });
});

describe("consent texts", () => {
  it("have a version marked as a draft", () => {
    expect(CONSENT_TEXT_VERSION).toBe("mandato-2026-11-14-borrador");
    expect(CONSENT_DRAFT_NOTICE.title).toBe("Borrador pendiente de revisión jurídica");
  });

  it("cover what the legal section asks for", () => {
    const mandate = JSON.stringify(MANDATE_TEXT);
    // What ReTren may and may not do, duration, revocation and price (ARCHITECTURE, legal).
    for (const word of ["presentar", "insistir", "escalar", "condiciones", "cobrar", "retirar"]) {
      expect(mandate.toLowerCase()).toContain(word);
    }
    expect(mandate).toContain("Gratis");
    const privacy = PRIVACY_NOTICE.items.map((i) => i.term);
    expect(privacy).toEqual([
      "Qué datos",
      "Para qué",
      "Quién los recibe",
      "Cuánto tiempo",
      "Tus derechos",
    ]);
  });
});

describe("toConsentRef", () => {
  it("gives A7 a valid ConsentRef", () => {
    const ref = toConsentRef({
      id: "5a4f3f8e-1d7b-4c43-9a59-2b8f2b6f9e01",
      draftId: null,
      acceptedAt: "2026-03-12T10:00:00.000Z",
      textVersion: CONSENT_TEXT_VERSION,
      ip: null,
      tripSnapshot: { ticket: REVIEWED_TICKET },
    });
    expect(ConsentRef.parse(ref)).toEqual({
      consentId: "5a4f3f8e-1d7b-4c43-9a59-2b8f2b6f9e01",
      mandateAccepted: true,
      gdprAccepted: true,
      textVersion: "mandato-2026-11-14-borrador",
      acceptedAt: "2026-03-12T10:00:00.000Z",
    });
  });
});
