export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: { extensions?: Json; operationName?: string; query?: string; variables?: Json };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      attachments: {
        Row: {
          case_id: string;
          content_type: string;
          created_at: string;
          deleted_at: string | null;
          filename: string;
          id: string;
          kind: Database["public"]["Enums"]["attachment_kind"];
          message_id: string | null;
          size_bytes: number | null;
          storage_path: string;
        };
        ComputedFields: never;
        Insert: {
          case_id: string;
          content_type: string;
          created_at?: string;
          deleted_at?: string | null;
          filename: string;
          id?: string;
          kind: Database["public"]["Enums"]["attachment_kind"];
          message_id?: string | null;
          size_bytes?: number | null;
          storage_path: string;
        };
        Update: {
          case_id?: string;
          content_type?: string;
          created_at?: string;
          deleted_at?: string | null;
          filename?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["attachment_kind"];
          message_id?: string | null;
          size_bytes?: number | null;
          storage_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: "attachments_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "attachments_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      case_events: {
        Row: {
          case_id: string;
          created_at: string;
          data: NonNullable<Json>;
          from_status: Database["public"]["Enums"]["case_status"] | null;
          id: string;
          kind: string;
          to_status: Database["public"]["Enums"]["case_status"] | null;
        };
        ComputedFields: never;
        Insert: {
          case_id: string;
          created_at?: string;
          data?: NonNullable<Json>;
          from_status?: Database["public"]["Enums"]["case_status"] | null;
          id?: string;
          kind: string;
          to_status?: Database["public"]["Enums"]["case_status"] | null;
        };
        Update: {
          case_id?: string;
          created_at?: string;
          data?: NonNullable<Json>;
          from_status?: Database["public"]["Enums"]["case_status"] | null;
          id?: string;
          kind?: string;
          to_status?: Database["public"]["Enums"]["case_status"] | null;
        };
        Relationships: [
          {
            foreignKeyName: "case_events_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "cases";
            referencedColumns: ["id"];
          },
        ];
      };
      cases: {
        Row: {
          created_at: string;
          earliest_send_at: string | null;
          eligibility: Json | null;
          id: string;
          next_action_at: string | null;
          operator: string;
          paused: boolean;
          public_ref: string;
          send_count: number;
          sent_at: string | null;
          status: Database["public"]["Enums"]["case_status"];
          submission: NonNullable<Json>;
          user_email: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          earliest_send_at?: string | null;
          eligibility?: Json | null;
          id?: string;
          next_action_at?: string | null;
          operator: string;
          paused?: boolean;
          public_ref?: string;
          send_count?: number;
          sent_at?: string | null;
          status?: Database["public"]["Enums"]["case_status"];
          submission: NonNullable<Json>;
          user_email: string;
        };
        Update: {
          created_at?: string;
          earliest_send_at?: string | null;
          eligibility?: Json | null;
          id?: string;
          next_action_at?: string | null;
          operator?: string;
          paused?: boolean;
          public_ref?: string;
          send_count?: number;
          sent_at?: string | null;
          status?: Database["public"]["Enums"]["case_status"];
          submission?: NonNullable<Json>;
          user_email?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          body_text: string | null;
          case_id: string | null;
          category: Database["public"]["Enums"]["reply_category"] | null;
          created_at: string;
          direction: Database["public"]["Enums"]["message_direction"];
          from_address: string;
          id: string;
          in_reply_to: string | null;
          message_id: string | null;
          raw_path: string | null;
          status: Database["public"]["Enums"]["message_status"];
          subject: string;
          to_address: string;
        };
        ComputedFields: never;
        Insert: {
          body_text?: string | null;
          case_id?: string | null;
          category?: Database["public"]["Enums"]["reply_category"] | null;
          created_at?: string;
          direction: Database["public"]["Enums"]["message_direction"];
          from_address: string;
          id?: string;
          in_reply_to?: string | null;
          message_id?: string | null;
          raw_path?: string | null;
          status: Database["public"]["Enums"]["message_status"];
          subject: string;
          to_address: string;
        };
        Update: {
          body_text?: string | null;
          case_id?: string | null;
          category?: Database["public"]["Enums"]["reply_category"] | null;
          created_at?: string;
          direction?: Database["public"]["Enums"]["message_direction"];
          from_address?: string;
          id?: string;
          in_reply_to?: string | null;
          message_id?: string | null;
          raw_path?: string | null;
          status?: Database["public"]["Enums"]["message_status"];
          subject?: string;
          to_address?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "cases";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      attachment_kind: "eu_form" | "mandate" | "ticket" | "user_document";
      case_status:
        | "draft"
        | "waiting_period"
        | "sent"
        | "reply_received"
        | "waiting_user"
        | "escalated"
        | "resolved"
        | "denied"
        | "closed";
      message_direction: "outbound" | "inbound";
      message_status: "queued" | "sent" | "failed" | "received";
      reply_category:
        "acknowledgement" | "asks_for_data" | "approved" | "denied" | "refers_to_form" | "other";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      attachment_kind: ["eu_form", "mandate", "ticket", "user_document"],
      case_status: [
        "draft",
        "waiting_period",
        "sent",
        "reply_received",
        "waiting_user",
        "escalated",
        "resolved",
        "denied",
        "closed",
      ],
      message_direction: ["outbound", "inbound"],
      message_status: ["queued", "sent", "failed", "received"],
      reply_category: [
        "acknowledgement",
        "asks_for_data",
        "approved",
        "denied",
        "refers_to_form",
        "other",
      ],
    },
  },
} as const;
