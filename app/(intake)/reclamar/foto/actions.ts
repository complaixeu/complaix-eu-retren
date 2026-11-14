"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  beginTicketUpload,
  finishUploadAndRead,
  intakeStepHref,
  readCurrentTicket,
  ticketVersion,
} from "@/features/intake";
import type {
  BeginUploadState,
  DeclaredTicketInput,
  ReadTicketState,
  TicketUploadState,
} from "./ticket-choice";

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
 * otherwise makes it the current draft and reads it ([A3]); setting the draft cookie re-renders
 * the step with the result. After the last unreadable photo it goes straight to the review
 * step, which then asks for every field.
 */
export async function finishUpload(): Promise<TicketUploadState> {
  let done;
  try {
    done = await finishUploadAndRead();
  } catch (error) {
    console.error("[intake] upload finish failed:", error instanceof Error ? error.message : error);
    return { status: "error", error: "failed" };
  }
  if (!done.ok) return { status: "error", error: done.error };
  // Outside the try: redirect() throws to navigate.
  if (done.next === "manual") redirect(intakeStepHref("revision"));
  return { status: "ok", key: ticketVersion(done.draft) };
}

/** Reads the current ticket again after a failure on our side ("Leer el billete"). */
export async function readTicket(): Promise<ReadTicketState> {
  let read;
  try {
    read = await readCurrentTicket();
  } catch (error) {
    console.error(
      "[intake] ticket reading failed:",
      error instanceof Error ? error.message : error,
    );
    return { status: "error" };
  }
  if (read.ok && read.next === "manual") redirect(intakeStepHref("revision"));
  refresh();
  return { status: "ok" };
}
