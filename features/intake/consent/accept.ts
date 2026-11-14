import type { IntakeDraft } from "../draft/store";
import { clientIp, type HeaderReader } from "./ip";
import { buildTripSnapshot } from "./snapshot";
import { insertConsent, type ConsentDeps, type ConsentRecord } from "./store";
import { CONSENT_TEXT_VERSION, type ConsentChoice } from "./texts";

export interface ConsentChoices {
  mandate: boolean;
  privacy: boolean;
}

export type AcceptConsentResult =
  | { ok: true; consent: ConsentRecord }
  /** One or both boxes unchecked: nothing is stored. */
  | { ok: false; reason: "not_accepted"; missing: ConsentChoice[] }
  /** The draft has no valid reviewed trip (or invalid answers): nothing is stored. */
  | { ok: false; reason: "review_missing" | "answers_invalid" };

/**
 * The authorization step's server side: refuses unless both the mandate and the privacy notice
 * are accepted, then stores the evidence (time, text version, IP from `headers`, trip snapshot).
 * It creates no case: submitting does ([A7]).
 */
export async function acceptConsent(
  draft: IntakeDraft,
  choices: ConsentChoices,
  deps: ConsentDeps & { headers: HeaderReader },
): Promise<AcceptConsentResult> {
  const missing = (["mandate", "privacy"] as const).filter((c) => choices[c] !== true);
  if (missing.length > 0) return { ok: false, reason: "not_accepted", missing };

  const trip = buildTripSnapshot(draft.data);
  if (!trip.ok) return { ok: false, reason: trip.reason };

  const consent = await insertConsent(
    {
      draftId: draft.id,
      textVersion: CONSENT_TEXT_VERSION,
      ip: clientIp(deps.headers),
      tripSnapshot: trip.snapshot,
    },
    deps,
  );
  return { ok: true, consent };
}

/** The two checkboxes from the posted form: checked only when the box sent its value. */
export function readConsentChoices(form: FormData): ConsentChoices {
  return { mandate: form.get("mandate") === "on", privacy: form.get("privacy") === "on" };
}
