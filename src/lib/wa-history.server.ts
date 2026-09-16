/** Archive lookup is opt-in, never automatic context for a fresh project. */
export function asksForPreviousChat(text: string): boolean {
  if (/\b(?:do not|don't|dont|ignore|forget)\b.*\b(?:previous|older|old|earlier|last)\b/i.test(text)) return false;
  return /\b(?:previous|older|old|earlier|last)\s+(?:chat|conversation|plan|quote|estimate|selection|design|budget|recommendation)s?\b|\b(?:what|which)\b.*\b(?:discussed|suggested|selected|chose)\s+(?:before|earlier|last time)\b|\b(?:continue|resume)\s+(?:where we left off|our last conversation)\b/i.test(text);
}

export async function previousChatContext(sessionKey: string): Promise<unknown> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("wa_messages")
    .select("direction,payload,created_at")
    .eq("session_key", sessionKey)
    .in("kind", ["text", "interactive", "document"])
    .order("created_at", { ascending: false }).limit(60);
  if (error) return { unavailable: true };
  // Bound model input; no images, internal events, phone numbers or other sessions.
  let remaining = 9000;
  const messages = (data ?? []).flatMap(row => {
    const p = row.payload as Record<string, unknown>;
    const text = [p["text"], p["caption"], p["buttonReplyTitle"]].find(v => typeof v === "string" && v.length) as string | undefined;
    if (!text || remaining <= 0) return [];
    const excerpt = text.slice(0, Math.min(1500, remaining));
    remaining -= excerpt.length;
    return [{ role: row.direction === "inbound" ? "customer" : "assistant", text: excerpt, at: row.created_at }];
  }).reverse();
  return { messages, limitedHistory: true };
}
