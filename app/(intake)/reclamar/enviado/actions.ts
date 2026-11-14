"use server";

import { redirect } from "next/navigation";
import { intakeStepHref, submitCurrentDraft } from "@/features/intake";

/**
 * Turns the current draft into a case ([A7]). Safe to run again: a draft that was already
 * submitted never makes a second case. Whatever happens, the user lands on the last step, which
 * shows the result or says what is missing. The mandate step hands off to this action.
 */
export async function submitClaim(): Promise<never> {
  let notice: "fallo" | "ocupado" | null = null;
  try {
    const out = await submitCurrentDraft();
    if (!out.ok && out.reason === "busy") notice = "ocupado";
  } catch (error) {
    // Only the error name: the message may quote the submission.
    console.error(`[intake] submit failed (${error instanceof Error ? error.name : "unknown"})`);
    notice = "fallo";
  }
  redirect(notice ? `${intakeStepHref("enviado")}?aviso=${notice}` : intakeStepHref("enviado"));
}
