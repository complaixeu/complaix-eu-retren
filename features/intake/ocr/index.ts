import type { OcrProvider } from "@/shared/contracts";
import { provider } from "@/shared/providers";
import { createFakeOcr } from "./fake";
import { createVisionOcr, type FetchLike } from "./vision";

/**
 * Picks the OCR implementation from OCR_PROVIDER (`fake` by default, see shared/providers.ts).
 * Server-only (the vision adapter holds the API key). Build it once, outside the request path:
 * it throws on a configuration error (unknown provider, vision without a key).
 */
export function createOcr(
  env: Record<string, string | undefined> = process.env,
  deps: { fetch?: FetchLike; fixtures?: Record<string, string> } = {},
): OcrProvider {
  if (provider("OCR_PROVIDER", env) === "vision") {
    const apiKey = env.GOOGLE_CLOUD_VISION_API_KEY;
    if (!apiKey) throw new Error("OCR_PROVIDER=vision needs GOOGLE_CLOUD_VISION_API_KEY to be set");
    return createVisionOcr({ apiKey, fetch: deps.fetch });
  }
  return createFakeOcr({ fixtures: deps.fixtures });
}
