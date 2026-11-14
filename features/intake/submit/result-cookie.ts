import { CreateCaseResult } from "@/shared/contracts";
import { DRAFT_TTL_MS } from "../draft/ttl";
import type { DraftCookieOptions } from "../draft/cookie";
import { draftCookieOptions } from "../draft/cookie";

/**
 * The result of the submission, kept in the browser so a reload of the last step shows it again
 * after the draft is gone. It holds the case reference and the rules' verdict: no name, email,
 * document or booking reference. Display only: the case itself lives in the database.
 */
export const RESULT_COOKIE = "retren_case";

export function serializeResult(result: CreateCaseResult): string {
  return JSON.stringify(CreateCaseResult.parse(result));
}

/** The result from a cookie value, or null if there is none or it is not one we wrote. */
export function parseResultCookie(value: string | null | undefined): CreateCaseResult | null {
  if (!value) return null;
  try {
    const parsed = CreateCaseResult.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Same scope and flags as the draft cookie, and as long-lived as a draft. */
export function resultCookieOptions(host: string | null | undefined): DraftCookieOptions {
  return { ...draftCookieOptions(host), maxAge: DRAFT_TTL_MS / 1000 };
}
