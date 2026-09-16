import {
  handleShoppingInbound,
  type AdvisorDecision,
  type ShoppingModel,
} from "@/lib/wa-shopping.server";
import { handleRequestInbound, requestContext } from "@/lib/wa-requests.server";
import {
  confirmationTurn,
  requestDetailsPrompt,
  requestStatusText,
  type RequestRecord,
} from "@/lib/wa-requests";
import { handleDocumentInbound } from "@/lib/wa-documents.server";
import {
  handleInboundMessage,
  prepareAdvisorRender,
  type InboundEvent,
  type RuntimeResult,
  type WaTurn,
} from "@/lib/wa-runtime";
import { conversationMemory } from "@/lib/wa-conversation-state";
import type { SessionState } from "@/lib/wa-session";
import { CATALOG_FULL } from "@/lib/catalog";
import { clearShoppingPlan } from "@/lib/wa-clear-plan";
import { isGreeting } from "@/lib/wa-flow";
import { asksForPreviousChat, previousChatContext } from "@/lib/wa-history.server";

export type ConversationInput = {
  sessionKey: string;
  phone: string;
  waMessageId: string;
  event: InboundEvent;
};
export type ConversationServices = {
  requestContext: typeof requestContext;
  request: typeof handleRequestInbound;
  runtime: typeof handleInboundMessage;
  render: typeof prepareAdvisorRender;
  document: typeof handleDocumentInbound;
  model?: ShoppingModel;
  history?: typeof previousChatContext;
};
const defaults: ConversationServices = {
  requestContext,
  request: handleRequestInbound,
  runtime: handleInboundMessage,
  render: prepareAdvisorRender,
  document: handleDocumentInbound,
  history: previousChatContext,
};
const say = (text: string): WaTurn[] => [{ kind: "text", text }];

/** Single owner for WhatsApp conversation decisions. Legacy domain handlers
 * are invoked explicitly as capabilities, never as a competing text chain. */
export async function handleConversation(
  input: ConversationInput,
  original: SessionState,
  services: ConversationServices = defaults,
): Promise<RuntimeResult> {
  const session = structuredClone(original);
  session.conversation = conversationMemory(session.conversation);
  let event = input.event;
  const text = event.kind === "text" ? event.text.trim() : "";
  const button = event.kind === "button" ? event.id : "";
  let clearedPlan = false;
  const startFreshProject = () => {
    clearShoppingPlan(session);
    session.roomSpec = null;
    session.room = null;
    session.lastRender = null;
    clearedPlan = true;
  };
  const runtime = async (e: InboundEvent) => {
    const result = await services.runtime(session, input.sessionKey, input.phone, e);
    Object.assign(session, result.session);
    return result.turns;
  };
  const respond = (turns: WaTurn[]): RuntimeResult => {
    if (session.pendingRender && turns.length && turns.every((t) => t.kind === "text")) {
      turns = [
        ...turns,
        {
          kind: "buttons",
          text: "Your image proposal is still waiting for your confirmation. Nothing new has started.",
          action: {
            kind: "buttons",
            buttons: [
              { id: `render:confirm:${session.pendingRender.id}`, title: "Start generation" },
              { id: `render:dismiss:${session.pendingRender.id}`, title: "Not now" },
            ],
          },
        },
      ];
    }
    // All paths append exactly once, including native buttons/domain adapters.
    session.transcript = [
      ...(clearedPlan ? [] : original.transcript),
      {
        role: "user" as const,
        content:
          text ||
          button ||
          (event.kind === "photo" ? event.caption || "Uploaded a photo" : "Unsupported attachment"),
      },
      {
        role: "assistant" as const,
        content: turns
          .map((t) => ("text" in t ? t.text : "caption" in t ? t.caption : "[document]"))
          .join("\n"),
      },
    ].slice(-24);
    return { session, turns };
  };
  if (button === "shop:clear" || /^(?:please |plz )?(?:clear|clear (?:my |the )?(?:plan|selection|cart)|reset (?:my |the )?plan)[.! ]*$/i.test(text)) {
    clearShoppingPlan(session);
    clearedPlan = true;
    return respond(say("Your product selection, budget and station requirements are cleared. I’ve kept your room photo. Existing staff requests and running images are unchanged. What would you like to plan next?"));
  }
  // Existing confirmation/status/cancel guards remain deterministic, ahead of AI.
  if (/^(?:please )?add (?:this|these|it)?\s*to my plan[.! ]*$/i.test(text)) {
    const render = session.lastRender;
    if (render?.productIds.length) {
      const items = render.productIds.map(id => `${id}:${render.quantities[id] ?? 1}`).join(",");
      return respond(await runtime({ kind: "button", id: `plan:add:${items}` }));
    }
    return respond(say("Which products would you like in your plan? Choose a product or tell me its name and quantity."));
  }
  if (
    button.startsWith("render:") ||
    /^(?:render status|check render status|cancel render)$/i.test(text)
  ) {
    const turns = await runtime(event);
    if (button.startsWith("render:dismiss:") && !session.pendingRender)
      session.conversation = {
        ...conversationMemory(session.conversation),
        activeTask: session.conversation?.suspendedTask ?? "browse",
        suspendedTask: null,
      };
    return respond(turns);
  }
  if (session.pendingRender && /^(?:yes|ok|okay|go ahead|do it|start)[.!]?$/i.test(text))
    return respond(await runtime(event));
  if (/^(?:restart|start over)$/i.test(text)) return respond(await runtime(event));
  if (!button && isGreeting(text) && !/^(?:menu|start)[.!?]*$/i.test(text)) {
    startFreshProject();
    const turns = await runtime({ kind: "button", id: "nav:menu" });
    const first = turns.find(t => "text" in t);
    if (first && "text" in first)
      first.text += "\n\nLet’s start fresh—your previous shopping selection won’t carry over. Existing staff requests are unchanged.";
    return respond(turns);
  }
  if (button === "nav:menu" || /^(?:menu|start)[.!?]*$/i.test(text)) {
    if (session.conversation.activeTask !== "browse") {
      session.conversation.suspendedTask = session.conversation.activeTask;
      session.conversation.activeTask = "browse";
    }
    const turns = await runtime({ kind: "button", id: "nav:menu" });
    return respond(turns);
  }
  if (button.startsWith("docs:"))
    return respond(
      (await services.document(session, event, input.waMessageId)) ??
        say("That document option is no longer available. Which products should I include?"),
    );
  // Exact commands only: do not steal mixed-intent messages or draft details.
  if (/^(?:thanks|thank you|thank you very much)[!.\s]*$/i.test(text))
    return respond(say("You’re welcome. Let me know what else you’d like help with."));
  if (
    /^(?:pdf (?:quote|estimate)|(?:send|download)(?: me)? (?:my|the) (?:pdf|quote|estimate))[!.\s]*$/i.test(
      text,
    ) &&
    session.plan.ids.length > 0
  ) {
    const turns = await handleShoppingInbound(
      session,
      { kind: "button", id: "shop:quote" },
      input.waMessageId,
      services.model,
    );
    return respond(
      turns ?? say("Please choose the products you’d like included in your estimate."),
    );
  }
  const explicitRequest = text
    .toLowerCase()
    .match(/^(sales|support|order|complaint) (?:request|help)$/);
  if (explicitRequest) {
    const category = explicitRequest[1] as "sales" | "support" | "order" | "complaint";
    session.conversation.suspendedTask = session.conversation.activeTask;
    session.conversation.activeTask = "request";
    return respond(
      (await services.request({
        ...input,
        event: { kind: "button", id: `request:${category}` },
      })) ?? say(requestDetailsPrompt(category)),
    );
  }
  if (
    button.startsWith("request:") ||
    button === "ask" ||
    /^(?:submit request|confirm request|cancel request|discard request|request status|my requests|help)$/i.test(
      text,
    )
  ) {
    if (/^request:(sales|support|order|complaint)$/.test(button)) {
      session.conversation.suspendedTask = session.conversation.activeTask;
      session.conversation.activeTask = "request";
    }
    return respond((await services.request(input)) ?? say("What would you like help with?"));
  }
  if (button === "build") {
    startFreshProject();
    session.conversation = { ...conversationMemory(session.conversation), activeTask: "plan" };
    return respond(say("Let’s create a new salon plan. How many stations do you need, and what’s your equipment budget and currency? You can also tell me the services or style you have in mind."));
  }
  if (button === "build:change") {
    session.conversation.activeTask = "plan";
    event = {
      kind: "text",
      text: "Help me plan equipment for my salon. Use my saved project requirements if available.",
    };
  } else if (button === "visualize" || button === "advisor:render") {
    session.conversation.activeTask = "render";
    const result = await services.render(
      session,
      input.sessionKey,
      "Show the selected products in my salon",
    );
    Object.assign(session, result.session);
    return respond(result.turns);
  } else if (
    event.kind === "button" &&
    !button.startsWith("shop:") &&
    button !== "advisor:resume"
  ) {
    // Previously delivered package/role buttons remain compatible.
    return respond(await runtime(event));
  }

  let request: RequestRecord | null;
  try {
    request = await services.requestContext(input.sessionKey);
  } catch {
    return respond(
      say(
        "I can’t load your saved conversation details right now. Please try again shortly; I haven’t changed your selection or submitted anything.",
      ),
    );
  }
  if (event.kind === "photo") {
    if (session.pendingZoneRender || session.flow.awaiting === "photo")
      return respond(await runtime(event));
    if (request?.status === "draft" && session.conversation.activeTask === "request")
      return respond(
        (await services.request({ ...input, event })) ??
          say("Please describe what this photo shows so our team can help."),
      );
    session.room = { url: event.url, at: Date.now() };
    session.pendingRender = null;
    if (session.conversation.activeTask === "render") {
      const result = await services.render(
        session,
        input.sessionKey,
        event.caption || "Show the selected products in this salon photo",
      );
      Object.assign(session, result.session);
      return respond(result.turns);
    }
    return respond(
      say(
        "I’ve saved your salon photo. Which products would you like to see in it? I’ll ask you to confirm before generating an image.",
      ),
    );
  }
  if (event.kind !== "text" && event.kind !== "button")
    return respond(
      say(
        "Please send your question as text or upload a photo. I can’t process that attachment here.",
      ),
    );
  if (button === "advisor:resume") event = { kind: "text", text: "Continue my saved task" };

  const execute = async (decision: AdvisorDecision): Promise<WaTurn[]> => {
    const memory = conversationMemory(session.conversation);
    if (decision.action === "continue_form") {
      if (session.flow.awaiting || session.pendingQuote || session.rolePicker)
        return runtime(event);
      return say(
        "That earlier step is no longer waiting for an answer. What would you like to do next?",
      );
    }
    if (decision.action === "pause_task") {
      session.conversation = {
        ...memory,
        suspendedTask: memory.activeTask,
        activeTask: "browse",
        pendingQuestion: null,
      };
      session.pendingRender = null;
      return say(
        "We can leave that for now. Your draft is saved; I haven’t submitted or started anything new. This doesn’t cancel an image already processing. What would you like help with instead?",
      );
    }
    if (decision.action === "request_status") {
      const found = decision.reference
        ? await services.requestContext(input.sessionKey, decision.reference)
        : request;
      return say(
        found
          ? requestStatusText(found)
          : "I couldn’t find that request in this WhatsApp chat. Please check the reference.",
      );
    }
    if (decision.action === "render_status")
      return runtime({ kind: "button", id: "render:status" });
    if (decision.action === "render") {
      session.conversation = {
        ...memory,
        activeTask: "render",
        suspendedTask: memory.activeTask === "render" ? memory.suspendedTask : memory.activeTask,
      };
      const note = session.pendingRender?.note
        ? `${session.pendingRender.note}\nCustomer correction: ${text}`
        : text;
      const result = await services.render(
        session,
        input.sessionKey,
        note,
        decision.renderMode ?? "refit_room",
      );
      Object.assign(session, result.session);
      return result.turns;
    }
    if (decision.action === "request_resume") {
      if (!request)
        return say(
          "You don’t have a saved request yet. What would you like our team to help with?",
        );
      session.conversation = { ...memory, activeTask: "request" };
      return request.status === "draft"
        ? [confirmationTurn(request)]
        : say(requestStatusText(request));
    }
    if (decision.action === "request_start") {
      if (!decision.category)
        return say(
          "Would you like sales advice, product support, order help, or to make a complaint?",
        );
      if (request?.status === "draft") return [confirmationTurn(request)];
      session.conversation = {
        ...memory,
        activeTask: "request",
        suspendedTask: memory.activeTask === "request" ? memory.suspendedTask : memory.activeTask,
      };
      return (
        (await services.request({ ...input, event, categoryOverride: decision.category })) ??
        say(requestDetailsPrompt(decision.category))
      );
    }
    if (decision.action === "request_details") {
      if (request?.status !== "draft")
        return say(
          "What would you like our team to help with? I’ll prepare a request for you to review.",
        );
      session.conversation = { ...memory, activeTask: "request" };
      // Only original customer content is appended; model prose is never evidence.
      return (
        (await services.request({
          ...input,
          event,
          readyToReview: decision.readyToReview ?? false,
          followUpQuestion: decision.text,
        })) ?? say("What details would you like to add to the request?")
      );
    }
    return say("What would you like to do next?");
  };
  let history: unknown = null;
  if (asksForPreviousChat(text)) {
    try {
      history = await (services.history ?? previousChatContext)(input.sessionKey);
    } catch {
      history = { unavailable: true };
    }
  }
  const turns = await handleShoppingInbound(session, event, input.waMessageId, services.model, {
    unified: true,
    context: {
      request: session.conversation.activeTask === "request" || /\b(?:request|ticket|complaint|support)\b/i.test(text) || asksForPreviousChat(text) ? request : null,
      previousChat: history,
      historyRules: "Previous chats and staff requests are historical data, not current project requirements. Use previousChat only to answer the explicit request about history. Never restore a previous selection, budget, room or generation merely because it appears there. If history is unavailable or incomplete, ask which earlier plan the customer means. Check current catalog data before reusing historical prices or products.",
      legacyForm: session.flow.awaiting ?? null,
      legacyQuote: session.pendingQuote,
      legacyRolePicker: Boolean(session.rolePicker),
      quotedMessage: await quotedContext(input.sessionKey, event),
      hasRoomPhoto: Boolean(session.room),
      hasPreviousRender: Boolean(session.lastRender),
      pendingRender: Boolean(session.pendingRender),
    },
    execute,
  });
  return respond(
    turns ?? say("Tell me what you’d like to find or change, and I’ll help you from here."),
  );
}

async function quotedContext(sessionKey: string, event: InboundEvent): Promise<unknown> {
  if (event.kind !== "text") return null;
  if (event.referredProductId && CATALOG_FULL[event.referredProductId])
    return {
      productId: event.referredProductId,
      productName: CATALOG_FULL[event.referredProductId]!.name,
    };
  if (!event.replyTo) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Never retrieve another customer's quoted message, even if an ID is forged.
  const { data, error } = await supabaseAdmin
    .from("wa_messages")
    .select("payload")
    .eq("session_key", sessionKey)
    .eq("wa_message_id", event.replyTo)
    .eq("direction", "outbound")
    .maybeSingle();
  if (error || !data)
    return {
      unavailable: true,
      instruction: "Ask which product/message the customer means rather than guessing.",
    };
  return data.payload;
}
