import type { OcrProvider } from "@/shared/contracts";
import { DEFAULT_EXTRACTION_MODEL } from "../extraction/gemini";
import { classifyQuality } from "./quality";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 20_000;
const TRANSCRIPTION_INSTRUCTION =
  "Transcribe ALL the visible text of this train ticket exactly as printed, line by line. Do not interpret, translate, add or correct anything. If you cannot read it, answer exactly UNREADABLE.";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function responseText(payload: unknown): string {
  const parts = (payload as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })
    ?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts)
    ? parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("")
    : "";
}

export function createGeminiOcr(options: {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}): OcrProvider {
  const { apiKey, model = DEFAULT_EXTRACTION_MODEL } = options;
  if (!apiKey) throw new Error("Gemini OCR needs GEMINI_API_KEY");
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

  return {
    async readText(file) {
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: TRANSCRIPTION_INSTRUCTION },
                  {
                    inlineData: {
                      mimeType: file.contentType,
                      data: Buffer.from(file.bytes).toString("base64"),
                    },
                  },
                ],
              },
            ],
            generationConfig: { temperature: 0 },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return { text: "", quality: "unreadable" };
        const text = responseText(await res.json());
        if (!text.trim() || text.trim().toUpperCase() === "UNREADABLE") {
          return { text, quality: "unreadable" };
        }
        return { text, quality: classifyQuality(text) };
      } catch {
        return { text: "", quality: "unreadable" };
      }
    },
  };
}
