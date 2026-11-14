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
  it("prefers x-vercel-forwarded-for, set by Vercel's proxy", () => {
    expect(
      clientIp(
        headers({
          "x-vercel-forwarded-for": "192.0.2.10",
          "x-forwarded-for": "203.0.113.7, 10.0.0.1",
          "x-real-ip": "198.51.100.1",
        }),
      ),
    ).toBe("192.0.2.10");
  });

  it("takes the first hop of x-vercel-forwarded-for if it holds a list", () => {
    expect(clientIp(headers({ "x-vercel-forwarded-for": "192.0.2.10, 10.0.0.1" }))).toBe(
      "192.0.2.10",
    );
  });

  it("falls back to x-forwarded-for when x-vercel-forwarded-for is not an address", () => {
    expect(
      clientIp(headers({ "x-vercel-forwarded-for": "garbage", "x-forwarded-for": "203.0.113.7" })),
    ).toBe("203.0.113.7");
  });

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

  it("is null without any of the headers", () => {
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

  it("adds only the answers that define the claim", () => {
    expect(buildTripSnapshot({ review: REVIEW, answers: ANSWERS })).toEqual({
      ok: true,
      snapshot: {
        ticket: REVIEWED_TICKET,
        answers: {
          actualArrival: ANSWERS.actualArrival,
          previousClaim: ANSWERS.previousClaim,
          paymentPreference: ANSWERS.paymentPreference,
        },
      },
    });
  });

  it("never keeps the identity answers: the evidence can't be erased", () => {
    const result = buildTripSnapshot({
      review: REVIEW,
      answers: { ...ANSWERS, documentType: "passport", documentNumber: "X1234567", extra: "y" },
    });
    expect(result.ok).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toContain("documentNumber");
    expect(text).not.toContain("X1234567");
    expect(text).not.toContain("documentType");
    expect(text).not.toContain("email");
    expect(text).not.toContain(ANSWERS.email);
    expect(text).not.toContain("extra");
  });

  it("keeps the details of an earlier claim, which are part of the claim", () => {
    const previousClaim = { made: true, date: "2026-03-11", recipient: "Iryo", means: "correo" };
    const result = buildTripSnapshot({ review: REVIEW, answers: { ...ANSWERS, previousClaim } });
    expect(result).toMatchObject({ ok: true, snapshot: { answers: { previousClaim } } });
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
    expect(CONSENT_TEXT_VERSION).toBe("mandato-2026-11-14-borrador-2");
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
    // The evidence itself is kept, and the notice says so (and for how long).
    const retention = PRIVACY_NOTICE.items.find((i) => i.term === "Cuánto tiempo")!.text;
    expect(retention).toContain(
      "El registro de tu aceptación (fecha y hora, versión del texto, IP y datos del viaje) se guarda como prueba del mandato mientras dure la reclamación y su posible defensa.",
    );
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
      textVersion: "mandato-2026-11-14-borrador-2",
      acceptedAt: "2026-03-12T10:00:00.000Z",
    });
  });
});
