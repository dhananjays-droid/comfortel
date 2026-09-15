import type { InboundEvent } from "@/lib/wa-runtime";
import type { SessionState } from "@/lib/wa-session";
import { requestIntent } from "@/lib/wa-requests";
import { wantsRender } from "@/lib/render-intent";

/** Rollout boundary, not a replacement intent classifier. Existing safety and
 * explicit navigation commands retain their original authoritative handlers. */
export function shoppingEligible(session: SessionState, event: InboundEvent): boolean {
  if (
    session.flow.awaiting ||
    session.pendingQuote ||
    session.rolePicker ||
    session.pendingRender ||
    session.pendingZoneRender
  )
    return false;
  if (event.kind === "button") return event.id.startsWith("shop:");
  if (event.kind !== "text") return false;
  const text = event.text.trim();
  if (requestIntent(text)) return false;
  if (/\b(render|rendering|visuali[sz]e|generation|image|photo|picture)\b/i.test(text))
    return false;
  if (
    /^(?:hi|hello|hey|menu|help|restart|reset|start over|stop|unsubscribe|resume|request status|my requests|cancel request|submit request|\?+|status|any updates?|still waiting|is it ready|how long)[.!?]*$/i.test(
      text,
    )
  )
    return false;
  if (
    /(?:render|image|generation).*(?:status|progress|ready|done|taking|waiting)|(?:status|progress|update|where|waiting|how long).*(?:render|image|generation)/i.test(
      text,
    )
  )
    return false;
  // PDF creation is shopping, not an image-generation operation.
  if (
    !/\b(pdf|quote|estimate|comparison)\b/i.test(text) &&
    wantsRender(text, Boolean(session.lastRender))
  )
    return false;
  return true;
}
