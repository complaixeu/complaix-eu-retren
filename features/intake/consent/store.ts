import type { SupabaseClient } from "@supabase/supabase-js";
import type { Clock, ConsentRef } from "@/shared/contracts";
import { systemClock } from "@/shared/clock";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { parseDraftId } from "../draft/cookie";
import type { TripSnapshot } from "./snapshot";

/**
 * The `consents` table (migration *_intake_consents.sql): evidence of each acceptance of the
 * mandate and the privacy notice. Insert-only and server-only: RLS on, no policies, and the
 * service role may only insert and read. Keep these types in step with the migration until
 * shared/supabase/database.types.ts is regenerated with it.
 */
type ConsentRow = {
  id: string;
  draft_id: string | null;
  accepted_at: string;
  text_version: string;
  ip: string | null;
  trip_snapshot: Json;
};

type ConsentsDatabase = {
  public: {
    Tables: {
      consents: {
        Row: ConsentRow;
        Insert: Omit<ConsentRow, "id"> & { id?: string };
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export interface ConsentRecord {
  id: string;
  /** Null once the draft is deleted (after submit, or by the purge); the evidence stays. */
  draftId: string | null;
  acceptedAt: string;
  textVersion: string;
  ip: string | null;
  tripSnapshot: TripSnapshot;
}

export interface ConsentDeps {
  db?: ServiceClient;
  clock?: Clock;
}

let defaultDb: ServiceClient | undefined;
const dbOf = (deps: ConsentDeps) =>
  (deps.db ?? (defaultDb ??= createServiceClient())) as unknown as SupabaseClient<ConsentsDatabase>;

function toRecord(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    acceptedAt: new Date(row.accepted_at).toISOString(),
    textVersion: row.text_version,
    ip: row.ip,
    tripSnapshot: row.trip_snapshot as unknown as TripSnapshot,
  };
}

/** Stores one acceptance. Both checkboxes must already be checked: see `acceptConsent`. */
export async function insertConsent(
  consent: { draftId: string; textVersion: string; ip: string | null; tripSnapshot: TripSnapshot },
  deps: ConsentDeps = {},
): Promise<ConsentRecord> {
  const { data, error } = await dbOf(deps)
    .from("consents")
    .insert({
      draft_id: consent.draftId,
      accepted_at: (deps.clock ?? systemClock).now().toISOString(),
      text_version: consent.textVersion,
      ip: consent.ip,
      trip_snapshot: consent.tripSnapshot as unknown as Json,
    })
    .select()
    .single();
  // The message may quote a value; callers log only the code.
  if (error || !data) throw new ConsentStoreError(error?.code ?? "no_row");
  return toRecord(data);
}

/** The draft's most recent consent, or null. For A7, to build the submission's `ConsentRef`. */
export async function latestConsent(
  draftId: string,
  deps: Pick<ConsentDeps, "db"> = {},
): Promise<ConsentRecord | null> {
  const id = parseDraftId(draftId);
  if (!id) return null;
  const { data, error } = await dbOf(deps)
    .from("consents")
    .select()
    .eq("draft_id", id)
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ConsentStoreError(error.code);
  return data ? toRecord(data) : null;
}

/**
 * The consent as the claims engine sees it. A row exists only when both boxes were checked, so
 * both acceptances are true.
 */
export function toConsentRef(consent: ConsentRecord): ConsentRef {
  return {
    consentId: consent.id,
    mandateAccepted: true,
    gdprAccepted: true,
    textVersion: consent.textVersion,
    acceptedAt: consent.acceptedAt,
  };
}

/** A failed read or write of `consents`. Carries only the database error code, never data. */
export class ConsentStoreError extends Error {
  constructor(readonly code: string) {
    super(`consents query failed (${code})`);
    this.name = "ConsentStoreError";
  }
}
