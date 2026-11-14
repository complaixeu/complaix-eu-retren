import type { Classifier } from "@/shared/contracts";
import { provider } from "@/shared/providers";
import { createFakeClassifier } from "./fake";
import { createGeminiClassifier, type FetchLike } from "./gemini";
import { looksLikeInjection } from "./guard";
import { OTHER, toVerdict } from "./verdict";

/**
 * Classifies an operator reply into the closed set of ARCHITECTURE §5. Internal to domain C: the
 * actions per category (C6) call it; it never sends, forwards or decides anything by itself.
 */

/** Wraps any classifier with the injection guard and the closed-set normalisation. */
export function guarded(
  inner: Classifier,
  options: { trustedDomains?: readonly string[] } = {},
): Classifier {
  return {
    async classify(mail) {
      if (looksLikeInjection(mail, options)) return { ...OTHER };
      return toVerdict(await inner.classify(mail));
    },
  };
}

/** Picks the implementation from LLM_PROVIDER (`fake` by default, see shared/providers.ts). */
export function createClassifier(
  env: Record<string, string | undefined> = process.env,
  deps: { fetch?: FetchLike; trustedDomains?: readonly string[] } = {},
): Classifier {
  const which = provider("LLM_PROVIDER", env);
  if (which === "gemini") {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("LLM_PROVIDER=gemini needs GEMINI_API_KEY to be set");
    const inner = createGeminiClassifier({
      apiKey,
      model: env.GEMINI_MODEL || undefined,
      fetch: deps.fetch,
    });
    return guarded(inner, deps);
  }
  return guarded(createFakeClassifier(), deps);
}
