import type { Extractor } from "@/shared/contracts";
import { provider } from "@/shared/providers";
import { createFakeExtractor } from "./fake";
import { DEFAULT_EXTRACTION_MODEL, createGeminiExtractor, type FetchLike } from "./gemini";

/**
 * Picks the extractor from LLM_PROVIDER (`fake` by default, see shared/providers.ts). Server-only
 * (the Gemini adapter holds the key). The model comes from GEMINI_EXTRACTION_MODEL, not
 * GEMINI_MODEL (that one is the claims classifier's). Throws on a configuration error: unknown
 * provider, gemini without a key, or a `-latest` model.
 */
export function createExtractor(
  env: Record<string, string | undefined> = process.env,
  deps: { fetch?: FetchLike; fixtures?: Record<string, unknown> } = {},
): Extractor {
  if (provider("LLM_PROVIDER", env) === "gemini") {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("LLM_PROVIDER=gemini needs GEMINI_API_KEY to be set");
    return createGeminiExtractor({
      apiKey,
      model: env.GEMINI_EXTRACTION_MODEL || DEFAULT_EXTRACTION_MODEL,
      fetch: deps.fetch,
    });
  }
  return createFakeExtractor({ fixtures: deps.fixtures });
}
