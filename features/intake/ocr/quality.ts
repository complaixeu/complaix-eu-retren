/** Below this many characters (after trimming) the OCR text is treated as unreadable. */
export const MIN_TEXT_LENGTH = 20;

export function classifyQuality(text: string): "ok" | "unreadable" {
  return text.trim().length < MIN_TEXT_LENGTH ? "unreadable" : "ok";
}
