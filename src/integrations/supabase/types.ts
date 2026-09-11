export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      wa_staff_conversations: {
        Row: { session_key: string; manual_mode: boolean; updated_at: string };
        Insert: { session_key: string; manual_mode?: boolean; updated_at?: string };
        Update: { manual_mode?: boolean; updated_at?: string };
        Relationships: [];
      };
      wa_staff_replies: {
        Row: {
          id: string;
          request_reference: string;
          session_key: string;
          body: string;
          state: string;
          wa_message_id: string | null;
          error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          request_reference: string;
          session_key: string;
          body: string;
          state?: string;
          wa_message_id?: string | null;
          error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          state?: string;
          wa_message_id?: string | null;
          error?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      wa_requests: {
        Row: {
          reference: string;
          session_key: string;
          source_message_id: string;
          category: string;
          status: string;
          stage: string;
          details: Json;
          customer_phone_enc: string;
          last_inbound_id: string | null;
          last_reply: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          reference: string;
          session_key: string;
          source_message_id: string;
          category: string;
          status?: string;
          stage?: string;
          details?: Json;
          customer_phone_enc: string;
          last_inbound_id?: string | null;
          last_reply?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          status?: string;
          stage?: string;
          details?: Json;
          last_inbound_id?: string | null;
          last_reply?: Json | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      shared_designs: {
        Row: {
          created_at: string;
          id: string;
          product_ids: string[];
          renders: Json;
          share_code: string;
          subtotal_cents: number | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          product_ids: string[];
          renders?: Json;
          share_code: string;
          subtotal_cents?: number | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          product_ids?: string[];
          renders?: Json;
          share_code?: string;
          subtotal_cents?: number | null;
        };
        Relationships: [];
      };
      enquiries: {
        Row: {
          additional_emails: string[];
          business_name: string | null;
          created_at: string;
          email: string;
          full_name: string;
          id: string;
          notes: string | null;
          phone: string | null;
          product_id: string;
          product_name: string;
          product_url: string | null;
          quantity: number;
          reference: string;
          visualization_url: string | null;
        };
        Insert: {
          additional_emails?: string[];
          business_name?: string | null;
          created_at?: string;
          email: string;
          full_name: string;
          id?: string;
          notes?: string | null;
          phone?: string | null;
          product_id: string;
          product_name: string;
          product_url?: string | null;
          quantity?: number;
          reference: string;
          visualization_url?: string | null;
        };
        Update: {
          additional_emails?: string[];
          business_name?: string | null;
          created_at?: string;
          email?: string;
          full_name?: string;
          id?: string;
          notes?: string | null;
          phone?: string | null;
          product_id?: string;
          product_name?: string;
          product_url?: string | null;
          quantity?: number;
          reference?: string;
          visualization_url?: string | null;
        };
        Relationships: [];
      };
      sessions: {
        Row: {
          channel: string;
          created_at: string;
          customer_name: string | null;
          expires_at: string;
          flow: Json;
          handoff: boolean;
          id: string;
          last_render: Json | null;
          offered: Json | null;
          pending_quote: Json | null;
          pending_zone_render: boolean;
          phone_last4: string | null;
          plan: Json;
          role_picker: Json | null;
          room_at: string | null;
          room_spec_depth_cm: number | null;
          room_spec_wall_cm: number | null;
          room_url: string | null;
          session_key: string;
          transcript: Json;
          updated_at: string;
        };
        Insert: {
          channel?: string;
          created_at?: string;
          customer_name?: string | null;
          expires_at?: string;
          flow?: Json;
          handoff?: boolean;
          id?: string;
          last_render?: Json | null;
          offered?: Json | null;
          pending_quote?: Json | null;
          pending_zone_render?: boolean;
          phone_last4?: string | null;
          plan?: Json;
          role_picker?: Json | null;
          room_at?: string | null;
          room_spec_depth_cm?: number | null;
          room_spec_wall_cm?: number | null;
          room_url?: string | null;
          session_key: string;
          transcript?: Json;
          updated_at?: string;
        };
        Update: {
          channel?: string;
          created_at?: string;
          customer_name?: string | null;
          expires_at?: string;
          flow?: Json;
          handoff?: boolean;
          id?: string;
          last_render?: Json | null;
          offered?: Json | null;
          pending_quote?: Json | null;
          pending_zone_render?: boolean;
          phone_last4?: string | null;
          plan?: Json;
          role_picker?: Json | null;
          room_at?: string | null;
          room_spec_depth_cm?: number | null;
          room_spec_wall_cm?: number | null;
          room_url?: string | null;
          session_key?: string;
          transcript?: Json;
          updated_at?: string;
        };
        Relationships: [];
      };
      visualizations: {
        Row: {
          created_at: string;
          hash: string;
          image_url: string | null;
          mode: string | null;
          product_id: string;
          task_id: string | null;
        };
        Insert: {
          created_at?: string;
          hash: string;
          image_url?: string | null;
          mode?: string | null;
          product_id: string;
          task_id?: string | null;
        };
        Update: {
          created_at?: string;
          hash?: string;
          image_url?: string | null;
          mode?: string | null;
          product_id?: string;
          task_id?: string | null;
        };
        Relationships: [];
      };
      wa_inbound_jobs: {
        Row: {
          attempt: number;
          completed_at: string | null;
          created_at: string;
          customer_name: string | null;
          customer_phone_enc: string;
          event: Json;
          id: string;
          last_error: string | null;
          session_key: string;
          started_at: string | null;
          status: string;
          updated_at: string;
          wa_message_id: string;
        };
        Insert: {
          attempt?: number;
          completed_at?: string | null;
          created_at?: string;
          customer_name?: string | null;
          customer_phone_enc: string;
          event: Json;
          id?: string;
          last_error?: string | null;
          session_key: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          wa_message_id: string;
        };
        Update: {
          attempt?: number;
          completed_at?: string | null;
          created_at?: string;
          customer_name?: string | null;
          customer_phone_enc?: string;
          event?: Json;
          id?: string;
          last_error?: string | null;
          session_key?: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          wa_message_id?: string;
        };
        Relationships: [];
      };
      wa_message_statuses: {
        Row: {
          created_at: string;
          details: Json;
          event_at: string;
          id: string;
          session_key: string | null;
          status: string;
          wa_message_id: string;
        };
        Insert: {
          created_at?: string;
          details?: Json;
          event_at: string;
          id?: string;
          session_key?: string | null;
          status: string;
          wa_message_id: string;
        };
        Update: {
          created_at?: string;
          details?: Json;
          event_at?: string;
          id?: string;
          session_key?: string | null;
          status?: string;
          wa_message_id?: string;
        };
        Relationships: [];
      };
      wa_messages: {
        Row: {
          created_at: string;
          direction: string;
          id: string;
          kind: string;
          payload: Json;
          session_key: string;
          wa_message_id: string;
        };
        Insert: {
          created_at?: string;
          direction: string;
          id?: string;
          kind: string;
          payload?: Json;
          session_key: string;
          wa_message_id: string;
        };
        Update: {
          created_at?: string;
          direction?: string;
          id?: string;
          kind?: string;
          payload?: Json;
          session_key?: string;
          wa_message_id?: string;
        };
        Relationships: [];
      };
      wa_render_jobs: {
        Row: {
          attempt: number;
          created_at: string;
          customer_phone_enc: string;
          error: string | null;
          id: string;
          kie_task_id: string | null;
          mode: string;
          note: string | null;
          product_ids: string[];
          quantities: Json;
          result_url: string | null;
          room_depth_cm: number | null;
          room_url: string | null;
          room_wall_cm: number | null;
          scene: string | null;
          session_key: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempt?: number;
          created_at?: string;
          customer_phone_enc: string;
          error?: string | null;
          id?: string;
          kie_task_id?: string | null;
          mode: string;
          note?: string | null;
          product_ids: string[];
          quantities?: Json;
          result_url?: string | null;
          room_depth_cm?: number | null;
          room_url?: string | null;
          room_wall_cm?: number | null;
          scene?: string | null;
          session_key: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempt?: number;
          created_at?: string;
          customer_phone_enc?: string;
          error?: string | null;
          id?: string;
          kie_task_id?: string | null;
          mode?: string;
          note?: string | null;
          product_ids?: string[];
          quantities?: Json;
          result_url?: string | null;
          room_depth_cm?: number | null;
          room_url?: string | null;
          room_wall_cm?: number | null;
          scene?: string | null;
          session_key?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      set_wa_staff_mode: {
        Args: { p_session_key: string; p_manual_mode: boolean };
        Returns: boolean;
      };
      claim_wa_staff_reply: {
        Args: { p_id: string; p_reference: string; p_session_key: string; p_body: string };
        Returns: boolean;
      };
      claim_wa_inbound_jobs: {
        Args: { p_limit?: number };
        Returns: Database["public"]["Tables"]["wa_inbound_jobs"]["Row"][];
      };
      enqueue_wa_inbound: {
        Args: {
          p_customer_name?: string | null;
          p_customer_phone_enc: string;
          p_event: Json;
          p_kind: string;
          p_message_payload: Json;
          p_session_key: string;
          p_wa_message_id: string;
        };
        Returns: boolean;
      };
    };
    Enums: {
      [_ in never]: never;
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
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
