"use server";

import { beginTicketUpload, finishTicketUpload, ticketVersion } from "@/features/intake";
import type { BeginUploadState, DeclaredTicketInput, TicketUploadState } from "./ticket-choice";

/**
 * The upload step's server actions. The file itself never comes through here: the browser PUTs
 * it straight to Storage between `beginUpload` and `finishUpload`, so no request to the app
 * carries more than a few hundred bytes.
 */

/** Step 1: a signed upload URL for the chosen file, if what the browser declares could pass. */
export async function beginUpload(declared: DeclaredTicketInput): Promise<BeginUploadState> {
  // Untrusted input: take only the three plain values.
  const input = {
    name: String(declared?.name ?? "").slice(0, 500),
    type: String(declared?.type ?? "").slice(0, 100),
    size: Number(declared?.size),
  };
  try {
    const begun = await beginTicketUpload(input);
    return begun.ok
      ? { status: "ready", uploadUrl: begun.uploadUrl, contentType: begun.contentType }
      : { status: "error", error: begun.error };
  } catch (error) {
    console.error("[intake] upload begin failed:", error instanceof Error ? error.message : error);
    return { status: "error", error: "failed" };
  }
}

/**
 * Step 2: checks the stored file (size, and type by its bytes), deletes it if it fails, and
 * otherwise makes it the current draft; setting the draft cookie re-renders the step.
 */
export async function finishUpload(): Promise<TicketUploadState> {
  try {
    const done = await finishTicketUpload();
    return done.ok
      ? { status: "ok", key: ticketVersion(done.draft) }
      : { status: "error", error: done.error };
  } catch (error) {
    console.error("[intake] upload finish failed:", error instanceof Error ? error.message : error);
    return { status: "error", error: "failed" };
  }
}
