import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import type { CreateCaseResult } from "@/shared/contracts";
import { DRAFT_COOKIE, clearedCookieOptions, type DraftCookieJar } from "../draft/cookie";
import { getCurrentDraft } from "../draft/session";
import {
  RESULT_COOKIE,
  parseResultCookie,
  resultCookieOptions,
  serializeResult,
} from "./result-cookie";
import { submitDraft, type SubmitDeps, type SubmitDraftResult } from "./submit";

/** Like the draft session: tests pass a `jar` instead of Next's `cookies()`. */
export interface SubmitSessionDeps extends SubmitDeps {
  jar?: DraftCookieJar;
  host?: string | null;
}

async function jarOf(deps: SubmitSessionDeps): Promise<DraftCookieJar> {
  if (deps.jar) return deps.jar;
  await connection();
  return cookies();
}

async function hostOf(deps: SubmitSessionDeps): Promise<string | null> {
  if (deps.host !== undefined) return deps.host;
  if (deps.jar) return null;
  return (await headers()).get("host");
}

/**
 * Server actions only (it sets cookies): submits this browser's current draft ([A7]). On success
 * the result goes into the result cookie, so the last step can show it after the draft is gone,
 * and the draft cookie is cleared.
 */
export async function submitCurrentDraft(
  deps: SubmitSessionDeps = {},
): Promise<SubmitDraftResult | { ok: false; reason: "no_draft" }> {
  const draft = await getCurrentDraft(deps);
  if (!draft) return { ok: false, reason: "no_draft" };

  const out = await submitDraft(draft, deps);
  if (out.ok) {
    const jar = await jarOf(deps);
    const host = await hostOf(deps);
    jar.set(RESULT_COOKIE, serializeResult(out.result), resultCookieOptions(host));
    jar.set(DRAFT_COOKIE, "", clearedCookieOptions(host));
  }
  return out;
}

/** The result of this browser's last submission, or null. Server components and actions. */
export async function currentResult(
  deps: Pick<SubmitSessionDeps, "jar"> = {},
): Promise<CreateCaseResult | null> {
  const jar = await jarOf(deps);
  return parseResultCookie(jar.get(RESULT_COOKIE)?.value);
}
