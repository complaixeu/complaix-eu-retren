import { getOperatorConfig } from "@/features/rules";
import type { Classifier, OperatorId } from "@/shared/contracts";
import { provider } from "@/shared/providers";
import { createFakeClassifier } from "./fake";
import { createGeminiClassifier, type FetchLike } from "./gemini";
import { looksLikeInjection, type Trust } from "./guard";
import { OTHER, toVerdict } from "./verdict";

/**
 * Classifies an operator reply into the closed set of ARCHITECTURE §5. Internal to domain C: the
 * actions per category (C6) call it; it never sends, forwards or decides anything by itself.
 *
 * Build the classifier once (at module load or app start), outside the request path:
 * `createClassifier` throws on a configuration error (unknown LLM_PROVIDER, gemini without a key),
 * while `classify` itself never throws.
 */

/** Placeholder until the real sending domain is chosen (C3, needs Nestor). */
export const DEFAULT_SENDING_DOMAIN = "retren.example";

export type CaseContext = {
  operator?: OperatorId;
  /** The case user's address, the only address outside a trusted domain that may be named. */
  userEmail?: string;
};

/**
 * Who a reply may name without being flagged: the operator's verified address domain (email
 * channels only), our own sending domain, and the case user's exact address. Never the From
 * header, which is whatever the sender claims.
 */
export function trustFor(ctx: CaseContext & { ownDomain: string }): Trust {
  const domains: string[] = [];
  if (ctx.operator) {
    const channel = getOperatorConfig(ctx.operator).channel;
    if (channel.type === "email") domains.push(channel.address.split("@")[1].toLowerCase());
  }
  domains.push(ctx.ownDomain.toLowerCase());
  return { domains, addresses: ctx.userEmail ? [ctx.userEmail.toLowerCase()] : [] };
}

/**
 * Wraps any classifier with the injection guard and the closed-set normalisation. Never throws:
 * a guard failure, an inner exception or garbage output all become `other` (team queue).
 */
export function guarded(inner: Classifier, trust: Trust): Classifier {
  return {
    async classify(mail) {
      try {
        if (looksLikeInjection(mail, trust)) return { ...OTHER };
        return toVerdict(await inner.classify(mail));
      } catch {
        return { ...OTHER };
      }
    },
  };
}

export type ReplyClassifier = Classifier & {
  /** The same model, guarded with the trust of one case (its operator and user). */
  forCase(ctx: CaseContext): Classifier;
};

/** Picks the implementation from LLM_PROVIDER (`fake` by default, see shared/providers.ts). */
export function createClassifier(
  env: Record<string, string | undefined> = process.env,
  deps: { fetch?: FetchLike } = {},
): ReplyClassifier {
  const which = provider("LLM_PROVIDER", env);
  let inner: Classifier;
  if (which === "gemini") {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("LLM_PROVIDER=gemini needs GEMINI_API_KEY to be set");
    inner = createGeminiClassifier({
      apiKey,
      model: env.GEMINI_MODEL || undefined,
      fetch: deps.fetch,
    });
  } else {
    inner = createFakeClassifier();
  }

  const ownDomain = env.MAIL_SENDING_DOMAIN || DEFAULT_SENDING_DOMAIN;
  // Without a case only our own domain is trusted: stricter, never looser.
  const bare = guarded(inner, trustFor({ ownDomain }));
  return {
    classify: (mail) => bare.classify(mail),
    forCase: (ctx) => guarded(inner, trustFor({ ...ctx, ownDomain })),
  };
}
