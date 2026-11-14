import { describe, expect, it } from "vitest";
import { parseAnswers, validIdentityNumber } from "@/features/intake/answers";

const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const valid = {
  documentType: "dni",
  documentNumber: "12345678Z",
  email: "viajera@example.com",
  arrivalDate: "2026-11-14",
  arrivalTime: "18:25",
  previousClaim: "no",
  paymentPreference: "money",
};

describe("A5 identity validation", () => {
  it.each([
    ["dni", "12345678Z"],
    ["nie", "X1234567L"],
    ["passport", "AB123456"],
  ] as const)("accepts a valid %s", (type, number) => {
    expect(validIdentityNumber(type, number)).toBe(true);
  });
  it.each([
    ["dni", "12345678A"],
    ["nie", "X1234567A"],
    ["passport", "??"],
  ] as const)("rejects an invalid %s", (type, number) => {
    expect(validIdentityNumber(type, number)).toBe(false);
  });
  it("parses the always asked answers", () => {
    expect(parseAnswers(form(valid))).toMatchObject({
      ok: true,
      value: { documentNumber: "12345678Z", email: valid.email, previousClaim: { made: false } },
    });
  });
  it("requires all previous claim details when the user has claimed", () => {
    expect(parseAnswers(form({ ...valid, previousClaim: "yes" })).ok).toBe(false);
    expect(
      parseAnswers(
        form({
          ...valid,
          previousClaim: "yes",
          claimDate: "2026-10-01",
          claimRecipient: "Renfe",
          claimMeans: "web",
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: { previousClaim: { made: true, recipient: "Renfe", means: "web" } },
    });
  });
  it("rejects invalid email, date and payment preference", () => {
    expect(
      parseAnswers(
        form({ ...valid, email: "bad", arrivalDate: "tomorrow", paymentPreference: "crypto" }),
      ).ok,
    ).toBe(false);
  });
});
