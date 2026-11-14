// Shared by the server action and the client form. Imports no domain code, so the client
// component may use it (tests/unit/intake/client-boundary.test.ts).

export type ConsentBox = "mandate" | "privacy";

export type ConsentFormState =
  | { status: "idle" }
  /** The server refused: these boxes were not checked. */
  | { status: "missing"; missing: ConsentBox[] }
  /** Storing the acceptance failed on our side. */
  | { status: "failed" };

/** Label and error text of each box, from the versioned texts on the server. */
export type ConsentBoxTexts = Record<ConsentBox, { label: string; error: string }>;

export const CONSENT_BOXES: readonly ConsentBox[] = ["mandate", "privacy"];

/** The boxes still unchecked, in page order. */
export function uncheckedBoxes(checked: Record<ConsentBox, boolean>): ConsentBox[] {
  return CONSENT_BOXES.filter((box) => !checked[box]);
}
