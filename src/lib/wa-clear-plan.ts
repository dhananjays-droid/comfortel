import type { SessionState } from "@/lib/wa-session";
import { conversationMemory } from "@/lib/wa-conversation-state";

/** Clear shopping intent as well as the basket so history cannot rebuild it.
 * Keep the room photo, customer identity and submitted staff records. */
export function clearShoppingPlan(session: SessionState) {
  session.plan = { ids: [], qty: {} };
  session.shoppingMemory = {};
  session.conversation = conversationMemory({});
  session.shownProductIds = [];
  session.rejectedProductIds = [];
  session.lastDocument = null;
  session.pendingRender = null;
  session.pendingQuote = null;
  session.pendingZoneRender = false;
  session.offered = null;
  session.rolePicker = null;
  session.flow = {};
  session.transcript = [];
}
