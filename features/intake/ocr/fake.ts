import { createHash } from "node:crypto";
import type { OcrProvider } from "@/shared/contracts";
import { classifyQuality } from "./quality";

/**
 * Fake `OcrProvider`: returns fixture text keyed by the sha256 (hex) of the file bytes. A file
 * with no fixture gets the safe default, empty text, which is `unreadable`. Never touches the
 * network. Tests pass their fixtures (see tests/fixtures/intake/ocr.ts).
 */
export function createFakeOcr(
  opts: { fixtures?: Record<string, string>; defaultText?: string } = {},
): OcrProvider {
  const fixtures = opts.fixtures ?? {};
  const defaultText = opts.defaultText ?? "";
  return {
    async readText(file) {
      const hash = createHash("sha256").update(file.bytes).digest("hex");
      const text = fixtures[hash] ?? defaultText;
      return { text, quality: classifyQuality(text) };
    },
  };
}
