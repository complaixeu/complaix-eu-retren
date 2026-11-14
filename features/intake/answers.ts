import { UserAnswers } from "@/shared/contracts";

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const NIE_LETTERS = "XYZ";

export function validIdentityNumber(type: "dni" | "nie" | "passport", raw: string): boolean {
  const value = raw.toUpperCase().replace(/[\s-]/g, "");
  if (type === "passport") return /^[A-Z0-9]{5,20}$/.test(value);
  if (type === "dni") {
    if (!/^\d{8}[A-Z]$/.test(value)) return false;
    return DNI_LETTERS[Number(value.slice(0, 8)) % 23] === value[8];
  }
  if (!/^[XYZ]\d{7}[A-Z]$/.test(value)) return false;
  const number = Number(value.replace(/^X/, "0").replace(/^Y/, "1").replace(/^Z/, "2").slice(0, 8));
  return DNI_LETTERS[number % 23] === value[8] && NIE_LETTERS.includes(value[0]);
}

export function parseAnswers(form: Pick<FormData, "get">) {
  const documentType = String(form.get("documentType") ?? "");
  const documentNumber = String(form.get("documentNumber") ?? "")
    .trim()
    .toUpperCase();
  const previousMade = form.get("previousClaim") === "yes";
  const value = {
    documentType,
    documentNumber,
    email: String(form.get("email") ?? "").trim(),
    actualArrival: {
      date: String(form.get("arrivalDate") ?? ""),
      time: String(form.get("arrivalTime") ?? ""),
    },
    previousClaim: previousMade
      ? {
          made: true as const,
          date: String(form.get("claimDate") ?? ""),
          recipient: String(form.get("claimRecipient") ?? "").trim(),
          means: String(form.get("claimMeans") ?? "").trim(),
        }
      : { made: false as const },
    paymentPreference: String(form.get("paymentPreference") ?? ""),
  };
  const parsed = UserAnswers.safeParse(value);
  const errors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      errors[key] = issue.code === "invalid_format" ? "Revisa el formato." : "Completa este dato.";
    }
  }
  if (
    ["dni", "nie", "passport"].includes(documentType) &&
    !validIdentityNumber(documentType as "dni" | "nie" | "passport", documentNumber)
  ) {
    errors.documentNumber =
      documentType === "passport"
        ? "Escribe un número de documento válido."
        : "La letra de control no coincide. Comprueba el número.";
  }
  return Object.keys(errors).length
    ? { ok: false as const, value, errors }
    : { ok: true as const, value: parsed.data };
}
