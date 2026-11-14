"use server";

import { readTicketUpload, startDraft } from "@/features/intake";
import type { TicketUploadState } from "./ticket-choice";

/**
 * The upload step's form action: checks the file on the server (size, and type by its bytes),
 * stores it as a new draft and sets the draft cookie, which re-renders the step with the preview.
 */
export async function uploadTicket(
  _previous: TicketUploadState,
  formData: FormData,
): Promise<TicketUploadState> {
  const read = await readTicketUpload(formData.get("ticket"));
  if (!read.ok) return { status: "error", error: read.error };
  try {
    const draft = await startDraft(read.ticket);
    return { status: "ok", key: draft.ticket!.path };
  } catch (error) {
    // No ticket data in the log, only what failed.
    console.error("[intake] ticket upload failed:", error instanceof Error ? error.message : error);
    return { status: "error", error: "failed" };
  }
}
