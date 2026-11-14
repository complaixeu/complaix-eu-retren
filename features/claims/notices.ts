// User notices (docs/plans/C-claims.md C8, ARCHITECTURE §7). The user hears from us only for a
// document request (C6), the final result (C2, C6, C7) and the escalation exception (§7.3, here).
// The sender (./send-queued.ts, ./outbound.ts USER_NOTICE_KINDS) enforces the kinds. Internal to
// domain C; the team view (C9) calls queueEscalationSignatureRequest.
import { renderTemplate } from "@/features/documents";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { ESCALATION_SIGNATURE_KIND } from "./outbound";
import { queueForTeam } from "./send-queued";

/** The team-queue reason C9 shows: a filing needs the user's name or signature (§7.3). */
export const ESCALATION_SIGNATURE_NEEDED = "escalation_signature_needed";

export type EscalationSignatureResult = {
  ok: false;
  /**
   * template_kind_missing: ESCALATION_SIGNATURE_KIND is not a TemplateKind yet (shared/contracts,
   * domain B), so there is no template of ours to send. Nothing is queued to the user.
   */
  reason: "case_not_found" | "template_kind_missing";
};

export interface NoticeDeps {
  /** Service-role client; created from env when left out. */
  db?: ServiceClient;
  /** B's renderTemplate. Only our template is ever sent, never operator text. */
  render?: typeof renderTemplate;
}

/**
 * The §7.3 exception: an escalation filing needs the user's name or signature and the mandate
 * doesn't cover it. Asked for by the team (C9). Always records a `team_queue` event
 * (escalation_signature_needed, ids only, at most once per case).
 *
 * Until `user_escalation_signature` is a TemplateKind there is no template to render, so it
 * refuses (template_kind_missing) and sends nothing: the team contacts the user by hand. Once the
 * contract has the kind, this renders it from the reference, the passenger and the operator only
 * (no operator text) and queues it to the case's own user (a test fails to say so).
 */
export async function queueEscalationSignatureRequest(
  caseId: string,
  deps: NoticeDeps = {},
): Promise<EscalationSignatureResult> {
  const db = deps.db ?? createServiceClient();
  const found = await db.from("cases").select("id").eq("id", caseId).maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) return { ok: false, reason: "case_not_found" };

  await queueForTeam(db, caseId, {
    reason: ESCALATION_SIGNATURE_NEEDED,
    template: ESCALATION_SIGNATURE_KIND,
  });
  // TODO(B6, contract): once TemplateKind has ESCALATION_SIGNATURE_KIND, render it (deps.render)
  // with {ref, passengerName, operatorName} only and queue it to cases.user_email. Until then
  // nothing is rendered or sent (tests/unit/claims/user-notices.test.ts fails when it lands).
  void deps.render;
  return { ok: false, reason: "template_kind_missing" };
}
