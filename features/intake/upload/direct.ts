import type { ServiceClient } from "@/shared/supabase/server";
import {
  TICKET_MAX_BYTES,
  TICKET_SNIFF_BYTES,
  detectTicketType,
  type TicketContentType,
  type TicketType,
  type TicketUploadError,
} from "./rules";

/**
 * The direct upload (A1 follow-up): the browser PUTs the file straight into Storage through a
 * signed upload URL, so no request to our server carries the file (hosting platforms cap request
 * bodies well under 10 MB). The file lands in a staging area, `uploads/<uuid>`, and only the
 * server check below moves it to its final, never-shown key under `drafts/`.
 */
export const UPLOAD_PREFIX = "uploads/";

/** What the browser says about the chosen file before uploading it. Untrusted. */
export interface DeclaredTicket {
  name: string;
  type: string;
  size: number;
}

const BY_EXTENSION: Record<string, TicketContentType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heic",
  pdf: "application/pdf",
};

const BY_MIME: Record<string, TicketContentType> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/heic": "image/heic",
  "image/heif": "image/heic",
  "application/pdf": "application/pdf",
};

/**
 * The content type the browser uploads the file with (the bucket only takes ours), from its
 * extension or its MIME type; null if it is neither. The bytes are checked after the upload.
 */
export function uploadContentType(
  file: Pick<DeclaredTicket, "name" | "type">,
): TicketContentType | null {
  const ext = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
  return (ext && BY_EXTENSION[ext]) || BY_MIME[file.type] || null;
}

/** A first, cheap refusal from what the browser declares. Never the check that counts. */
export function declaredTicketError(
  file: DeclaredTicket,
): Extract<TicketUploadError, "empty" | "too_large" | "wrong_type"> | null {
  if (!(file.size > 0)) return "empty";
  if (file.size > TICKET_MAX_BYTES) return "too_large";
  return uploadContentType(file) ? null : "wrong_type";
}

/** The few Storage operations the check needs (a fake in unit tests). */
export interface StoredObjects {
  /** Size in bytes, or null if there is no such object. */
  size(path: string): Promise<number | null>;
  /** The object's bytes, or null if there is no such object. */
  read(path: string): Promise<Uint8Array | null>;
  remove(path: string): Promise<void>;
}

export type StoredTicketCheck =
  | { ok: true; type: TicketType; size: number }
  | {
      ok: false;
      error: Extract<TicketUploadError, "empty" | "too_large" | "wrong_type" | "not_received">;
    };

/**
 * The server check of a staged upload: it exists, is not empty, is at most 10 MB (from Storage's
 * own metadata, before reading anything) and starts with the bytes of an accepted type. A staged
 * object that fails is deleted.
 */
export async function checkStoredTicket(
  path: string,
  objects: StoredObjects,
): Promise<StoredTicketCheck> {
  if (!path.startsWith(UPLOAD_PREFIX)) return { ok: false, error: "not_received" };
  const size = await objects.size(path);
  if (size === null) return { ok: false, error: "not_received" };

  const refuse = async (error: "empty" | "too_large" | "wrong_type") => {
    await objects.remove(path);
    return { ok: false as const, error };
  };
  if (size <= 0) return refuse("empty");
  if (size > TICKET_MAX_BYTES) return refuse("too_large");

  const bytes = await objects.read(path);
  if (!bytes) return { ok: false, error: "not_received" };
  const type = detectTicketType(bytes.subarray(0, TICKET_SNIFF_BYTES));
  return type ? { ok: true, type, size } : refuse("wrong_type");
}

/** `StoredObjects` over a Storage bucket, through the service client. */
export function storedObjects(db: ServiceClient, bucket: string): StoredObjects {
  const files = () => db.storage.from(bucket);
  return {
    async size(path) {
      const { data, error } = await files().info(path);
      if (error || !data) return null;
      return typeof data.size === "number" ? data.size : null;
    },
    async read(path) {
      const { data, error } = await files().download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(path) {
      const { error } = await files().remove([path]);
      if (error) throw new Error(`staged ticket delete failed: ${error.message}`);
    },
  };
}
