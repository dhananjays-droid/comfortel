import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { waSessionKey } from "@/lib/wa-session.server";

export function contactPreference(text: string): boolean | null {
  if (
    /^(?:stop(?: messaging me)?|unsubscribe|do not message me|don't message me)[.!]*$/i.test(
      text.trim(),
    )
  )
    return true;
  if (/^(?:resume messages|subscribe|start messaging me)[.!]*$/i.test(text.trim())) return false;
  return null;
}
export async function setContactPreference(sessionKey: string, optedOut: boolean): Promise<void> {
  const { error } = await supabaseAdmin.rpc("wa_set_contact_opt_out", {
    p_session_key: sessionKey,
    p_opted_out: optedOut,
  });
  if (error) throw error;
}
export async function assertContactAllowed(phone: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("wa_contact_opted_out", {
    p_session_key: waSessionKey(phone),
  });
  // Fail closed: a database outage cannot silently bypass an opt-out.
  if (error) throw new Error("Messaging preferences unavailable; message not sent");
  if (data) throw new Error("Customer has opted out of WhatsApp messages");
}
