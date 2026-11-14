import { createHash } from "node:crypto";
import type { Extractor } from "@/shared/contracts";
import { toExtraction } from "./never-invent";

/**
 * Fake `Extractor`: the "model answer" comes from a fixture keyed by the sha256 (hex) of the OCR
 * text, and then goes through the same validation and "never invent" post-check as Gemini's. A
 * text with no fixture gets an empty answer: nothing extracted, every field missing. Never
 * touches the network. Tests pass their fixtures (see tests/fixtures/intake/extraction.ts).
 */
export function createFakeExtractor(opts: { fixtures?: Record<string, unknown> } = {}): Extractor {
  const fixtures = opts.fixtures ?? {};
  return {
    async extract(ocrText) {
      const hash = createHash("sha256").update(ocrText).digest("hex");
      return toExtraction(fixtures[hash] ?? {}, ocrText);
    },
  };
}
