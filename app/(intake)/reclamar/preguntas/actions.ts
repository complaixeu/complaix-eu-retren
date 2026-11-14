"use server";

import { redirect } from "next/navigation";
import { intakeStepHref, mergeDraftData, requireDraft } from "@/features/intake";
import { parseAnswers } from "@/features/intake";
import type { Json } from "@/shared/supabase";

export type AnswersState = { status: "idle" } | { status: "error"; errors: Record<string, string> };

export async function saveAnswers(_state: AnswersState, formData: FormData): Promise<AnswersState> {
  const draft = await requireDraft();
  const result = parseAnswers(formData);
  if (!result.ok) return { status: "error", errors: result.errors };
  await mergeDraftData(draft.id, { answers: result.value as Json });
  redirect(intakeStepHref("mandato"));
}
