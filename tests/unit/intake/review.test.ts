import { describe, expect, it } from "vitest";
import {
  REVIEW_FIELDS,
  REVIEW_REQUIRED_FIELDS,
  reviewErrorMessage,
} from "@/features/intake/review/fields";
import { readReview } from "@/features/intake/review/read";
import {
  parseReviewDate,
  parseReviewTime,
  validateReview,
} from "@/features/intake/review/validate";
import { SubmittedTicket, TicketData } from "@/shared/contracts";
import {
  fullTicket,
  manualExtraction,
  partialExtraction,
  reviewForm,
} from "../../fixtures/intake/extraction";

// [A4] Review screen: field validation (dates, times, arrival after departure) and reading what
// the draft holds (the saved review first, then the extraction; anything malformed is ignored).

// 12:00 in Madrid on 2026-03-20.
const now = new Date("2026-03-20T11:00:00.000Z");
const validate = (overrides: Record<string, string | null> = {}) =>
  validateReview(reviewForm(overrides), { now });

function errorsOf(overrides: Record<string, string | null>) {
  const result = validate(overrides);
  if (result.ok) throw new Error("expected the review to be rejected");
  return result.errors;
}

describe("the field list", () => {
  it("covers every TicketData field once, with a Spanish label", () => {
    const names = REVIEW_FIELDS.map((f) => f.name).sort();
    expect(names).toEqual(Object.keys(TicketData.shape).sort());
    for (const field of REVIEW_FIELDS) expect(field.label).toMatch(/^[A-ZÁÉÍÓÚ¿]/);
  });

  it("requires exactly the SubmittedTicket fields", () => {
    const required = Object.entries(SubmittedTicket.shape)
      .filter(([, schema]) => !schema.safeParse(undefined).success)
      .map(([name]) => name)
      .sort();
    expect([...REVIEW_REQUIRED_FIELDS].sort()).toEqual(required);
  });

  it("uses date and time inputs for dates and times", () => {
    const kind = (name: string) => REVIEW_FIELDS.find((f) => f.name === name)?.kind;
    expect(kind("travelDate")).toBe("date");
    expect(kind("purchaseDate")).toBe("date");
    expect(kind("scheduledDeparture")).toBe("time");
    expect(kind("scheduledArrival")).toBe("time");
    expect(kind("operator")).toBe("choice");
  });
});

describe("validateReview", () => {
  it("accepts a complete review and returns a SubmittedTicket", () => {
    const result = validate();
    expect(result).toEqual({ ok: true, ticket: fullTicket });
    if (result.ok) expect(SubmittedTicket.safeParse(result.ticket).success).toBe(true);
  });

  it("trims text and leaves empty optional fields out", () => {
    const result = validate({
      origin: "  Estación Uno ",
      ticketNumber: "",
      trainNumber: "   ",
      price: null,
      purchaseDate: "",
      purchaseChannel: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ticket.origin).toBe("Estación Uno");
    for (const key of [
      "ticketNumber",
      "trainNumber",
      "price",
      "purchaseDate",
      "purchaseChannel",
    ] as const) {
      expect(result.ticket).not.toHaveProperty(key);
    }
  });

  it("asks for every required field that is empty", () => {
    const empty = Object.fromEntries(REVIEW_REQUIRED_FIELDS.map((f) => [f, ""]));
    const errors = errorsOf(empty);
    for (const field of REVIEW_REQUIRED_FIELDS) expect(errors[field]).toBe("required");
    expect(errors.ticketNumber).toBeUndefined();
  });

  it("refuses to continue unless the localizador is confirmed", () => {
    expect(errorsOf({ bookingRefConfirmed: null })).toEqual({ bookingRefConfirmed: "unconfirmed" });
    expect(errorsOf({ bookingRefConfirmed: "no" })).toEqual({ bookingRefConfirmed: "unconfirmed" });
  });

  it("refuses an operator it doesn't know", () => {
    expect(errorsOf({ operator: "otra" })).toEqual({ operator: "invalid_choice" });
    expect(errorsOf({ purchaseChannel: "otro" })).toEqual({ purchaseChannel: "invalid_choice" });
  });

  it("refuses overlong text", () => {
    expect(errorsOf({ origin: "x".repeat(121) })).toEqual({ origin: "too_long" });
  });

  it("returns what the user typed alongside the errors, so the form keeps it", () => {
    const result = validate({ origin: "", destination: "Otra estación" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.values.destination).toBe("Otra estación");
    expect(result.values.bookingRefConfirmed).toBe("yes");
  });

  describe("dates", () => {
    it.each([
      ["2026-02-30", "invalid_date"],
      ["2026-13-01", "invalid_date"],
      ["2025-02-29", "invalid_date"],
      ["12-03-2026", "invalid_date"],
      ["mañana", "invalid_date"],
    ])("refuses %s as the travel date", (travelDate, code) => {
      expect(errorsOf({ travelDate })).toEqual({ travelDate: code });
    });

    it("accepts a leap day and the DD/MM/YYYY a browser without a date picker sends", () => {
      const leap = validate({ travelDate: "2024-02-29", purchaseDate: "2024-02-01" });
      expect(leap.ok && leap.ticket.travelDate).toBe("2024-02-29");
      const typed = validate({ travelDate: "12/3/2026", purchaseDate: "01/03/2026" });
      expect(typed.ok && typed.ticket).toMatchObject({
        travelDate: "2026-03-12",
        purchaseDate: "2026-03-01",
      });
    });

    it("refuses a trip that hasn't happened yet (Madrid's calendar day)", () => {
      expect(validate({ travelDate: "2026-03-20" }).ok).toBe(true);
      expect(errorsOf({ travelDate: "2026-03-21" })).toEqual({ travelDate: "future_date" });
      // 23:30 UTC on the 20th is already the 21st in Madrid.
      const lateNight = validateReview(reviewForm({ travelDate: "2026-03-21" }), {
        now: new Date("2026-03-20T23:30:00.000Z"),
      });
      expect(lateNight.ok).toBe(true);
    });

    it("refuses a purchase after the trip or in the future", () => {
      expect(validate({ purchaseDate: "2026-03-12" }).ok).toBe(true);
      expect(errorsOf({ purchaseDate: "2026-03-13" })).toEqual({
        purchaseDate: "purchase_after_travel",
      });
      expect(errorsOf({ purchaseDate: "2026-04-01", travelDate: "2026-04-02" })).toEqual({
        travelDate: "future_date",
        purchaseDate: "future_date",
      });
      expect(errorsOf({ purchaseDate: "2026-02-30" })).toEqual({ purchaseDate: "invalid_date" });
    });
  });

  describe("times", () => {
    it.each(["24:00", "12:60", "9", "0910", "09:10:00x", "las nueve"])("refuses %s", (time) => {
      expect(errorsOf({ scheduledDeparture: time, scheduledArrival: "23:59" })).toEqual({
        scheduledDeparture: "invalid_time",
      });
    });

    it("accepts HH:MM, and pads H:MM", () => {
      const result = validate({ scheduledDeparture: "7:05", scheduledArrival: "23:59" });
      expect(result.ok && result.ticket).toMatchObject({
        scheduledDeparture: "07:05",
        scheduledArrival: "23:59",
      });
      expect(validate({ scheduledDeparture: "00:00", scheduledArrival: "00:01" }).ok).toBe(true);
    });

    it("requires the arrival to be after the departure", () => {
      expect(errorsOf({ scheduledDeparture: "11:55", scheduledArrival: "09:10" })).toEqual({
        scheduledArrival: "arrival_not_after_departure",
      });
      expect(errorsOf({ scheduledDeparture: "10:00", scheduledArrival: "10:00" })).toEqual({
        scheduledArrival: "arrival_not_after_departure",
      });
    });

    it("doesn't compare the times when one of them is already wrong", () => {
      expect(errorsOf({ scheduledDeparture: "99:00", scheduledArrival: "09:00" })).toEqual({
        scheduledDeparture: "invalid_time",
      });
    });
  });

  describe("the parsers", () => {
    it("parseReviewDate normalizes or returns null", () => {
      expect(parseReviewDate("2026-03-12")).toBe("2026-03-12");
      expect(parseReviewDate("01/02/2026")).toBe("2026-02-01");
      expect(parseReviewDate("31/04/2026")).toBeNull();
      expect(parseReviewDate("")).toBeNull();
    });

    it("parseReviewTime normalizes or returns null", () => {
      expect(parseReviewTime("09:10")).toBe("09:10");
      expect(parseReviewTime("9:10")).toBe("09:10");
      expect(parseReviewTime("23:60")).toBeNull();
    });
  });
});

describe("reviewErrorMessage", () => {
  it("says what happened and what to do, in Spanish", () => {
    expect(reviewErrorMessage("bookingRef", "required")).toBe(
      "Escribe el localizador tal como aparece en el billete.",
    );
    expect(reviewErrorMessage("bookingRefConfirmed", "unconfirmed")).toMatch(/localizador/);
    expect(reviewErrorMessage("scheduledArrival", "arrival_not_after_departure")).toMatch(
      /posterior a la de salida/,
    );
    for (const field of REVIEW_REQUIRED_FIELDS) {
      expect(reviewErrorMessage(field, "required")).toMatch(/\.$/);
    }
  });
});

describe("readReview", () => {
  const reviewedAt = "2026-03-20T11:00:00.000Z";

  it("with nothing stored, asks for every field (manual entry)", () => {
    const read = readReview({});
    expect(read.source).toBe("manual");
    expect(read.ticket).toEqual({});
    expect([...read.missing].sort()).toEqual(Object.keys(TicketData.shape).sort());
    expect(read.confirmed).toBe(false);
  });

  it("shows the extraction and its missing fields", () => {
    const read = readReview({ extraction: partialExtraction });
    expect(read.source).toBe("extraction");
    expect(read.ticket).toEqual(partialExtraction.data);
    // In the order the screen shows them.
    expect(read.missing).toEqual(["bookingRef", "ticketNumber", "scheduledArrival"]);
  });

  it("also marks a required field the extraction left empty but didn't list", () => {
    const data: Record<string, string> = { ...fullTicket };
    delete data.lastName;
    const read = readReview({ extraction: { ...partialExtraction, data, missing: [] } });
    expect(read.missing).toEqual(["lastName"]);
  });

  it("treats the manual-entry extraction like nothing read", () => {
    const read = readReview({ extraction: manualExtraction });
    expect(read.ticket).toEqual({});
    expect(read.missing).toHaveLength(Object.keys(TicketData.shape).length);
  });

  it("prefers the saved review, keeping the extraction's missing marks", () => {
    const read = readReview({
      extraction: partialExtraction,
      review: { ticket: fullTicket, bookingRefConfirmed: true, reviewedAt },
    });
    expect(read).toEqual({
      source: "review",
      ticket: fullTicket,
      missing: ["bookingRef", "ticketNumber", "scheduledArrival"],
      confirmed: true,
    });
  });

  it.each([
    ["a string", "nope"],
    ["an unconfirmed review", { ticket: fullTicket, bookingRefConfirmed: false, reviewedAt }],
    ["a bad date", { ticket: { travelDate: "2026-02-30" }, bookingRefConfirmed: true, reviewedAt }],
    ["no reviewedAt", { ticket: fullTicket, bookingRefConfirmed: true }],
  ])("ignores a malformed review (%s)", (_, review) => {
    const read = readReview({ extraction: partialExtraction, review });
    expect(read.source).toBe("extraction");
    expect(read.ticket).toEqual(partialExtraction.data);
  });

  it.each([
    ["null", null],
    ["a bad time", { ...partialExtraction, data: { scheduledDeparture: "25:00" } }],
    ["an unknown missing field", { ...partialExtraction, missing: ["seat"] }],
    ["no quality", { data: {}, missing: [] }],
  ])("ignores a malformed extraction (%s)", (_, extraction) => {
    expect(readReview({ extraction }).source).toBe("manual");
  });
});

describe("the client form's mirror of the server", () => {
  it("posts the confirmation value the server expects", async () => {
    const { CONFIRM_VALUE } = await import("@/app/(intake)/reclamar/revision/review-state");
    const { BOOKING_REF_CONFIRMED } = await import("@/features/intake/review/validate");
    expect(CONFIRM_VALUE).toBe(BOOKING_REF_CONFIRMED);
  });
});
