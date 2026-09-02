/**
 * Phase 5, build-order item 14: "a phone number sending 50 messages/minute
 * should not enqueue 50 renders."
 *
 * No new table — `wa_messages` and `wa_render_jobs` already log exactly what
 * a rate limiter needs to count (session_key + created_at, on every inbound
 * message and every enqueued render), so this is a windowed COUNT against
 * data that's being written anyway, not new state.
 *
 * Fails OPEN on any error (never blocks a real customer over a transient DB
 * hiccup), the same resilience stance every other *.server.ts store in this
 * channel takes. This is a real trade-off, not an oversight: during an
 * outage, abuse protection silently disables itself rather than the bot
 * breaking for everyone. Logged loudly either way so a real outage is still
 * visible.
 *
 * Thresholds are a starting point, not a measured figure — the build order
 * (§14) is explicit that this should be sized "against actual expected
 * launch volume," which isn't known yet. Revisit once there's real traffic.
 */

const MESSAGE_WINDOW_MS = 60 * 1000;
const MAX_MESSAGES_PER_WINDOW = 20;

const RENDER_WINDOW_MS = 5 * 60 * 1000;
const MAX_RENDERS_PER_WINDOW = 5;

/** Checked in wa-webhook.server.ts before dispatching to handleInboundMessage()
 * — an over-limit message is dropped silently rather than answered, since
 * replying to a flood also bills a conversation under WhatsApp's per-message
 * pricing (§10 of the plan). */
export async function tooManyInboundMessages(sessionKey: string): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count, error } = await supabaseAdmin
      .from("wa_messages")
      .select("id", { count: "exact", head: true })
      .eq("session_key", sessionKey)
      .eq("direction", "inbound")
      .gte("created_at", new Date(Date.now() - MESSAGE_WINDOW_MS).toISOString());
    if (error) {
      console.error("wa-rate-limit: count failed on wa_messages", error);
      return false;
    }
    return (count ?? 0) >= MAX_MESSAGES_PER_WINDOW;
  } catch (err) {
    console.error("wa-rate-limit: count failed on wa_messages", err);
    return false;
  }
}

/** Checked in wa-runtime.ts before enqueueing a render — unlike a message
 * flood, a real customer can legitimately hit this, so it gets an
 * explanation rather than silence. */
export async function tooManyRenderRequests(sessionKey: string): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count, error } = await supabaseAdmin
      .from("wa_render_jobs")
      .select("id", { count: "exact", head: true })
      .eq("session_key", sessionKey)
      .gte("created_at", new Date(Date.now() - RENDER_WINDOW_MS).toISOString());
    if (error) {
      console.error("wa-rate-limit: count failed on wa_render_jobs", error);
      return false;
    }
    return (count ?? 0) >= MAX_RENDERS_PER_WINDOW;
  } catch (err) {
    console.error("wa-rate-limit: count failed on wa_render_jobs", err);
    return false;
  }
}
