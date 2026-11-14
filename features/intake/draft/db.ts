import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/shared/supabase";
import type { ServiceClient } from "@/shared/supabase/server";

/**
 * The intake tables as the service client sees them (migration *_intake_tickets_drafts.sql).
 * shared/supabase/database.types.ts is generated and owned by domain C; until it is regenerated
 * with this migration, intake types its own tables here. Keep this in step with the migration.
 */
export const INTAKE_DRAFT_STATUSES = ["uploaded"] as const;
export type IntakeDraftStatus = (typeof INTAKE_DRAFT_STATUSES)[number];

export type IntakeDraftRow = {
  id: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  status: IntakeDraftStatus;
  ticket_path: string | null;
  ticket_content_type: string | null;
  ticket_filename: string | null;
  ticket_size_bytes: number | null;
  data: Json;
};

type IntakeDraftInsert = Partial<IntakeDraftRow> & Pick<IntakeDraftRow, "expires_at">;

export type IntakeDatabase = {
  public: {
    Tables: {
      intake_drafts: {
        Row: IntakeDraftRow;
        Insert: IntakeDraftInsert;
        Update: Partial<IntakeDraftRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      intake_merge_draft_data: {
        Args: {
          p_id: string;
          p_patch: Json;
          p_status?: IntakeDraftStatus | null;
          p_now?: string;
        };
        Returns: IntakeDraftRow[];
      };
    };
    Enums: { intake_draft_status: IntakeDraftStatus };
    CompositeTypes: { [_ in never]: never };
  };
};

export type IntakeClient = SupabaseClient<IntakeDatabase>;

/** The shared service client, typed for the intake tables. */
export const intakeClient = (db: ServiceClient): IntakeClient => db as unknown as IntakeClient;
