import type { OcrProvider } from "@/shared/contracts";
import { classifyQuality } from "./quality";

/**
 * Google Cloud Vision adapter for `OcrProvider`, over REST with `fetch` (no SDK). Server-only:
 * it holds `GOOGLE_CLOUD_VISION_API_KEY`, so import it only from server code. The key goes in a
 * header, never in the URL, and never in an error message. Tests inject a fake `fetch`.
 * Images use `images:annotate`; PDFs use `files:annotate` (inline, first pages). Other types
 * (such as HEIC) are not supported by Vision and come back `unreadable` (the user is asked for
 * another photo).
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const BASE = "https://vision.googleapis.com/v1";
const TIMEOUT_MS = 20_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);
const FEATURES = [{ type: "DOCUMENT_TEXT_DETECTION" }];

type Annotated = {
  fullTextAnnotation?: { text?: unknown };
  error?: { code?: unknown };
};

/** A per-request error inside an HTTP 200: throw with the code only, never message or key. */
function assertNoError(r: Annotated | undefined): void {
  if (r?.error) {
    const code = typeof r.error.code === "number" ? r.error.code : "unknown";
    throw new Error(`Vision OCR returned error code ${code}`);
  }
}

function textOf(r: Annotated | undefined): string {
  const t = r?.fullTextAnnotation?.text;
  return typeof t === "string" ? t : "";
}

export function createVisionOcr(opts: { apiKey: string; fetch?: FetchLike }): OcrProvider {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));

  async function call(path: string, body: unknown): Promise<unknown> {
    const res = await doFetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Deliberately not echoing the response body: it could repeat request details.
    if (!res.ok) throw new Error(`Vision OCR request failed with HTTP ${res.status}`);
    return res.json();
  }

  return {
    async readText(file) {
      const type = file.contentType.toLowerCase();
      const content = Buffer.from(file.bytes).toString("base64");
      let text = "";
      if (IMAGE_TYPES.has(type)) {
        const data = (await call("images:annotate", {
          requests: [{ image: { content }, features: FEATURES }],
        })) as { responses?: Annotated[] };
        assertNoError(data.responses?.[0]);
        text = textOf(data.responses?.[0]);
      } else if (type === "application/pdf") {
        // Inline `files:annotate` accepts at most 5 pages per request and a limited payload
        // (about 20 MB request size, so about 10 MB of PDF after base64); larger or longer
        // PDFs would need the async GCS flow. A1 caps uploads at 10 MB; only the first 5
        // pages are read, enough for a ticket.
        const data = (await call("files:annotate", {
          requests: [
            {
              inputConfig: { content, mimeType: "application/pdf" },
              features: FEATURES,
              pages: [1, 2, 3, 4, 5],
            },
          ],
        })) as { responses?: (Annotated & { responses?: Annotated[] })[] };
        assertNoError(data.responses?.[0]);
        const pages = data.responses?.[0]?.responses ?? [];
        pages.forEach(assertNoError);
        text = pages.map(textOf).filter(Boolean).join("\n");
      } else {
        return { text: "", quality: "unreadable" };
      }
      return { text, quality: classifyQuality(text) };
    },
  };
}
