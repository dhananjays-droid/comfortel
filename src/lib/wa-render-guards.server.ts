import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Durable claims shared by all worker invocations. Uses the existing unique
 * wa_message_id constraint, so deploying this requires no schema migration.
 * Reservations are audit records, not WhatsApp message ids.
 */
export async function claimRenderAction(
  jobId: string,
  sessionKey: string,
  action: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin.from("wa_messages").insert({
    wa_message_id: `internal:render:${jobId}:${action}`,
    session_key: sessionKey,
    direction: "outbound",
    kind: "internal",
    payload: { action, jobId },
  });
  if (error && error.code !== "23505") console.error("Render action claim failed", error);
  // Fail closed: losing a reassurance is preferable to spamming a customer.
  return !error;
}
