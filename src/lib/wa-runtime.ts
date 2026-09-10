/**
 * The conversation engine — a server-side port of the dispatcher
 * `src/routes/index.tsx` runs in `useState`/`useRef`, driven by a `sessions`
 * DB row instead of component state.
 *
 * Ported function-by-function from `index.tsx` on `main` (`sendTurn`,
 * `offerPackages`, `acceptPackage`, `acceptOffer`, `startRender`,
 * `renderPlanByZone`, `runChat`) — read that file, not this comment, for the
 * source of truth on any edge case. Three things are genuinely new here, not
 * ported, because a webhook has no browser and WhatsApp has no proactive
 * business-initiated message outside a template:
 *  1. The greeting is sent as part of the reply to a customer's FIRST ever
 *     message, rather than pre-seeded before any input exists (§0 of the
 *     plan requires "they get the same greeting-with-three-buttons").
 *  2. The "talk to a person" handoff trigger (§8 of the plan) — index.tsx
 *     has no equivalent because the web app has no compliance requirement to
 *     escalate.
 *  3. `renderPlan()`/`renderPlanStaged()` (the PlanTray's plain "Visualize"/
 *     "staged" buttons) are NOT ported: they have no WhatsApp trigger, since
 *     WhatsApp has no floating tray UI and index.tsx's own `sendTurn`
 *     dispatcher never calls them from text either — a customer's plain
 *     "show me my plan" is already served by chat()'s own render/offer
 *     marker, which `runChatTurn` below handles. `renderPlanByZone` IS
 *     ported because it has a real text trigger (`wantsZoneSplit`).
 */

import { CATALOG_FULL, getProduct, formatPrice, type FullProduct } from "@/lib/catalog";
import {
  parseChatInput,
  runChatTurn as runChatCore,
  type ChatMessageInput,
  type RenderRequest,
} from "@/lib/chat.functions";
import { parseCurateInput, runCuratePackages } from "@/lib/curate.functions";
import { parseEnquiryInput, runSubmitEnquiry } from "@/lib/enquiry.functions";
import {
  buildPackages,
  candidatesNear,
  distinctPackages,
  idsOf,
  needsFor,
  packageLine,
  ROLE_LABEL,
  ROLE_ORDER,
  stationsForBudget,
  TIER_LABEL,
  type Line,
  type Package,
  type Role,
} from "@/lib/packages";
import { expectedFrom, linesFrom, planPieces, planTotal, quantitiesFor } from "@/lib/plan";
import { wantsZoneSplit } from "@/lib/render-intent";
import { tooManyRenderRequests } from "@/lib/wa-rate-limit.server";
import { genericCapacity } from "@/lib/room";
import {
  cancelActiveRenderJobs,
  enqueueRenderJob,
  getActiveRenderState,
  type ActiveRenderState,
} from "@/lib/wa-render-jobs.server";
import {
  liveLastRender,
  liveOffered,
  liveRolePicker,
  liveRoom,
  sanitizeRoomSpec,
  type SessionLastRender,
  type SessionOffered,
  type SessionOfferedChoice,
  type SessionPendingQuote,
  type SessionPlan,
  type SessionRolePick,
  type SessionRolePicker,
  type SessionRoomPhoto,
  type SessionState,
} from "@/lib/wa-session";
import { isMultiReferenceMode, isVisualizeMode, type VisualizeMode } from "@/lib/visualize-prompt";
import { WA, truncate } from "@/lib/whatsapp";
import { groupByZone, isSplittable } from "@/lib/zones";
import {
  INITIAL,
  advance,
  buildIntake,
  describeIntake,
  readIntake,
  welcome,
  type WaAction,
} from "@/lib/wa-flow";

/** Assumed when the customer did not say. Stated out loud, never silent — matches index.tsx. */
const DEFAULT_STATIONS = 4;
const DEFAULT_BUDGET = 15000;

/** Matches `isGreeting()`'s style: a fixed phrase list, not a model call. */
const HANDOFF_PHRASE =
  /\b(talk to (a )?(person|human|agent)|speak to (a )?(person|human|agent)|real (person|human)|human please|agent please)\b/i;
const HANDOFF_ACK =
  "Got it, I'll get a person to pick this up from here. They'll reply in this chat shortly.";

function wantsHandoff(text: string): boolean {
  return HANDOFF_PHRASE.test(text);
}

export type WaTurn =
  | { kind: "text"; text: string }
  | { kind: "buttons"; text: string; action: WaAction & { kind: "buttons" } }
  | { kind: "list"; text: string; action: WaAction & { kind: "list" } }
  | { kind: "product"; imageUrl: string; caption: string };

/**
 * The web app shows a rich `ProductCard` (photo, price, buttons) for every
 * id in `res.productIds` via `ProductStrip` — WhatsApp has no equivalent
 * widget, so this was silently dropped in the initial port, and a customer
 * asking "show me its images" got nothing. The nearest WhatsApp primitive is
 * a plain image message; one per product, in order, each with the name,
 * price and a link to the full listing as the caption.
 */
export function productTurns(productIds: string[]): WaTurn[] {
  return productIds
    .map((id) => getProduct(id))
    .filter((p): p is FullProduct => p !== undefined && p.images.length > 0)
    .map((p) => ({
      kind: "product" as const,
      imageUrl: p.images[0]!,
      caption: [`*${p.name}*`, formatPrice(p.price), p.url].filter(Boolean).join("\n"),
    }));
}

/**
 * The default next step whenever products were shown but the model did not
 * already offer or trigger a render for them — a customer should never have
 * to find the exact right phrasing to get a picture; a tap should always be
 * on offer instead. staged_room is always the mode here since it is the one
 * that works whether or not a room photo exists.
 */
export function proactiveOfferTurn(productIds: string[]): WaTurn | null {
  if (!productIds.length) return null;
  return {
    kind: "buttons",
    text: "Want to see it in your space?",
    action: {
      kind: "buttons",
      buttons: [{ id: `offer:staged_room:${productIds.join(",")}`, title: "See it in your space" }],
    },
  };
}

/** A real customer can legitimately hit the render rate limit (unlike a
 * message flood, which is dropped silently) — this gets an explanation
 * rather than a dropped request. See wa-rate-limit.server.ts. */
const RATE_LIMITED_TURN: WaTurn = {
  kind: "text",
  text: "That's a few renders in a row, give it a few minutes and ask again and I'll get started.",
};

/** Sent instead of a false "rendering now" confirmation when
 * enqueueRenderJob couldn't actually write the job after retrying — a real
 * production bug this replaces: the confirmation used to send unconditionally,
 * so the customer would be told a render had started when it never had. */
const RENDER_FAILED_TURN: WaTurn = {
  kind: "text",
  text: "Sorry, something went wrong starting that render. Please try again in a moment.",
};

export type InboundEvent =
  | { kind: "text"; text: string }
  | { kind: "button"; id: string }
  | { kind: "photo"; url: string; caption?: string | undefined }
  | { kind: "photo_error" }
  | { kind: "unsupported" };

export type RuntimeResult = { session: SessionState; turns: WaTurn[] };

function renderBusyTurn(
  active: ActiveRenderState,
  photoSaved = false,
): Extract<WaTurn, { kind: "buttons" }> {
  const progress = active.generating
    ? `${active.generating} generating`
    : `${active.pending} waiting to start`;
  const intro = photoSaved
    ? "I saved this as the room photo for your next render."
    : "A render is already in progress, so I haven’t started another one.";
  return {
    kind: "buttons",
    text: `${intro} Your current request is still active (${progress}).`,
    action: {
      kind: "buttons",
      buttons: [
        { id: "render:status", title: "Check status" },
        { id: "render:cancel", title: "Cancel render" },
        { id: "nav:menu", title: "Main menu" },
      ],
    },
  };
}

function planProductsOf(session: SessionState): FullProduct[] {
  return session.plan.ids.map((id) => getProduct(id)).filter((p): p is FullProduct => Boolean(p));
}

function pieceCount(
  products: FullProduct[],
  quantities: Record<string, number> | undefined,
): number {
  return planPieces(linesFrom(products, quantities));
}

function appendTranscript(
  session: SessionState,
  role: "user" | "assistant",
  content: string,
): SessionState {
  if (!content.trim()) return session;
  return { ...session, transcript: [...session.transcript, { role, content }] };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** Matches buildRenderMessage's per-entry label in index.tsx. */
function entryLabel(mode: VisualizeMode, ids: string[]): string {
  if (mode === "refit_room") return "Your salon, refitted";
  if (mode === "staged_room") return "Your plan, staged in a salon";
  if (mode === "lineup") return `${ids.length} options in your space`;
  return getProduct(ids[0]!)?.name ?? "Your render";
}

/**
 * Enqueues one wa_render_jobs row per group and returns the confirmation text
 * — the server-side equivalent of buildRenderMessage + runRender, minus the
 * "asked" bubble (that only exists in index.tsx to echo the customer's own
 * tap back into the web UI's transcript; on WhatsApp the customer already
 * knows what they asked, so nothing is sent for it — it still goes into
 * session.transcript so future chat() calls see consistent history).
 */
async function startRenderTurn(
  session: SessionState,
  sessionKey: string,
  phone: string,
  products: FullProduct[],
  mode: VisualizeMode,
  photo: SessionRoomPhoto | null,
  quantities: Record<string, number> | undefined,
  /** The customer's own words for this request — see visualize-prompt.ts's noteClause(). */
  note?: string | undefined,
): Promise<RuntimeResult> {
  const active = await getActiveRenderState(sessionKey);
  if (active.count) return { session, turns: [renderBusyTurn(active)] };
  if (await tooManyRenderRequests(sessionKey)) return { session, turns: [RATE_LIMITED_TURN] };

  const ids = products.map((p) => p.id);
  const roomSpec = session.roomSpec ?? undefined;
  const groups: string[][] = isMultiReferenceMode(mode) ? [ids] : ids.map((id) => [id]);

  let enqueued = 0;
  for (const groupIds of groups) {
    const qty = quantitiesFor(mode, groupIds, quantities);
    const ok = await enqueueRenderJob(sessionKey, phone, {
      mode,
      productIds: groupIds,
      ...(qty ? { quantities: qty } : {}),
      ...(photo ? { roomUrl: photo.url } : {}),
      ...(roomSpec ? { roomWallCm: roomSpec.wallCm, roomDepthCm: roomSpec.depthCm } : {}),
      ...(note ? { note } : {}),
    });
    if (ok) enqueued++;
  }
  // Every group failed to enqueue (already retried inside enqueueRenderJob) —
  // tell the customer honestly rather than sending a confirmation for a
  // render that was never actually queued.
  if (enqueued === 0) return { session, turns: [RENDER_FAILED_TURN] };

  const verb =
    mode === "add" ? "into" : mode === "replace_all" ? "throughout" : "in place of what's in";
  const askedText = photo
    ? products.length > 1
      ? `Fit my space out with these ${pieceCount(products, quantities)} pieces.`
      : `Show me the ${products[0]?.name ?? "this piece"} ${verb} my space.`
    : products.length > 1
      ? `Build a salon around these ${pieceCount(products, quantities)} pieces.`
      : `Show me the ${products[0]?.name ?? "this piece"} in a salon.`;

  const names = products.map((p) => p.name).filter(Boolean);
  const contentText =
    mode === "refit_room"
      ? "I’ve started refitting your salon with those Comfortel pieces. This usually takes 1–2 minutes ⏳"
      : mode === "staged_room"
        ? "I’ve started building that salon. This usually takes 1–2 minutes ⏳"
        : mode === "lineup"
          ? `I’ve started placing ${names.join(", ")} side by side. This usually takes 1–2 minutes ⏳`
          : groups.length > 1
            ? `I’ve started ${groups.length} options for your space. This usually takes 1–2 minutes ⏳`
            : `I’ve started rendering the ${entryLabel(mode, groups[0]!)} in your space. This usually takes 1–2 minutes ⏳`;

  let next = appendTranscript(session, "user", askedText);
  next = appendTranscript(next, "assistant", contentText);

  return { session: next, turns: [{ kind: "text", text: contentText }] };
}

/**
 * A targeted change to the last render — "make the chairs blue" — not a
 * new composition. New, not ported: index.tsx has its own equivalent (see
 * runEditRender), but the mechanics differ enough (session-backed
 * lastRender vs. a ref) that this isn't a shared function.
 *
 * Deliberately not routed through startRenderTurn: that function's whole
 * shape — products, quantities, a room photo, per-mode wording — doesn't
 * apply here. edit anchors on the previous RESULT image (never the
 * customer's own room photo) and installs nothing new.
 */
async function startEditTurn(
  session: SessionState,
  sessionKey: string,
  phone: string,
  lastRender: SessionLastRender,
  note: string | undefined,
): Promise<RuntimeResult> {
  const active = await getActiveRenderState(sessionKey);
  if (active.count) return { session, turns: [renderBusyTurn(active)] };
  if (await tooManyRenderRequests(sessionKey)) return { session, turns: [RATE_LIMITED_TURN] };

  const ok = await enqueueRenderJob(sessionKey, phone, {
    mode: "edit",
    productIds: [],
    roomUrl: lastRender.resultUrl,
    ...(note ? { note } : {}),
  });
  if (!ok) return { session, turns: [RENDER_FAILED_TURN] };

  const askedText = note ? `Change the render: ${note}` : "Update my last render.";
  const contentText = "I’ve started updating that render. This usually takes 1–2 minutes ⏳";

  let next = appendTranscript(session, "user", askedText);
  next = appendTranscript(next, "assistant", contentText);

  return { session: next, turns: [{ kind: "text", text: contentText }] };
}

/**
 * Ported: same zone split, same staged fallback when there's no photo yet.
 * No longer photo-gated, matching index.tsx's own comment on this function.
 */
async function renderPlanByZoneTurn(
  session: SessionState,
  sessionKey: string,
  phone: string,
): Promise<RuntimeResult> {
  const planProducts = planProductsOf(session);
  if (!planProducts.length) return { session, turns: [] };
  const active = await getActiveRenderState(sessionKey);
  if (active.count) return { session, turns: [renderBusyTurn(active)] };
  if (await tooManyRenderRequests(sessionKey)) return { session, turns: [RATE_LIMITED_TURN] };

  const photo = liveRoom(session.room);
  const groups = groupByZone(planProducts);
  const roomSpec = session.roomSpec ?? undefined;
  const mode: VisualizeMode = photo ? "refit_room" : "staged_room";

  let enqueued = 0;
  for (const group of groups) {
    const ids = group.products.map((p) => p.id);
    const qty = quantitiesFor(mode, ids, session.plan.qty);
    const ok = await enqueueRenderJob(sessionKey, phone, {
      mode,
      productIds: ids,
      scene: group.scene,
      ...(qty ? { quantities: qty } : {}),
      ...(photo ? { roomUrl: photo.url } : {}),
      ...(roomSpec ? { roomWallCm: roomSpec.wallCm, roomDepthCm: roomSpec.depthCm } : {}),
    });
    if (ok) enqueued++;
  }
  if (enqueued === 0) return { session, turns: [RENDER_FAILED_TURN] };

  const zones = groups.map((g) => g.label.toLowerCase()).join(", ");
  const contentText = `I’ve started the zone renders for ${zones}. They usually take 1–2 minutes each ⏳`;
  const next = appendTranscript(session, "assistant", contentText);
  return { session: next, turns: [{ kind: "text", text: contentText }] };
}

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

/**
 * Pause before the expensive package build and let the customer correct the
 * two facts that most affect price. The original free-text brief is already in
 * the transcript, so the confirm button does not need to carry customer data
 * in its id or add another session column.
 */
function confirmBuildDetails(session: SessionState, text: string): RuntimeResult {
  const intake = readIntake(text);
  const fromWall = intake.wallCm ? genericCapacity({ wallCm: intake.wallCm, unit: "ft" }).fits : 0;
  const budget = intake.budget || DEFAULT_BUDGET;
  const stations =
    intake.stations ||
    fromWall ||
    (intake.budget ? stationsForBudget(intake.budget) : DEFAULT_STATIONS);

  const stationSource = intake.stations
    ? "you specified"
    : fromWall
      ? "estimated from the wall length"
      : intake.budget
        ? "recommended for that budget"
        : "assumed";
  const budgetText = intake.budgetMin
    ? `${formatPrice(intake.budgetMin)}–${formatPrice(budget)}; I’ll treat ${formatPrice(budget)} as the cap`
    : `${formatPrice(budget)}${intake.budget ? "" : " assumed"}`;
  const wallText = intake.wallCm
    ? `\n• Room: about ${Math.round(intake.wallCm / 30.48)}ft${intake.depthCm ? ` × ${Math.round(intake.depthCm / 30.48)}ft` : " wall"}`
    : "";
  const replyText = [
    "Before I build the options, please check I understood you:",
    "",
    `• ${stations} styling station${stations === 1 ? "" : "s"} (${stationSource})`,
    `• Furniture budget: ${budgetText}${wallText}`,
    "",
    "This is the catalog-furniture budget; freight and lead time are confirmed with the final quote. Are these details right?",
  ].join("\n");

  let next = session;
  if (intake.wallCm) {
    next = {
      ...next,
      roomSpec: sanitizeRoomSpec({ wallCm: intake.wallCm, depthCm: intake.depthCm }),
    };
  }
  next = appendTranscript(next, "user", text);
  next = appendTranscript(next, "assistant", replyText);
  next = { ...next, flow: { awaiting: "confirm_build" } };

  return {
    session: next,
    turns: [
      {
        kind: "buttons",
        text: replyText,
        action: {
          kind: "buttons",
          buttons: [
            { id: "build:confirm", title: "Use these details" },
            { id: "build:change", title: "Change details" },
            { id: "nav:menu", title: "Main menu" },
          ],
        },
      },
    ],
  };
}

function latestUserText(session: SessionState): string | null {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const message = session.transcript[i];
    if (message?.role === "user" && message.content.trim()) return message.content.trim();
  }
  return null;
}

/**
 * Sent immediately, before the package-curation call below — that call is a
 * real Claude Sonnet round trip reading ~80 candidate products (a few
 * seconds, not the sub-second reply a plain chat question gets), and unlike
 * a render it had no interim message at all: a customer asking for a budget
 * plan just watched the chat go quiet. Mirrors the render flow's own
 * "please wait" pattern. Best-effort and fire-and-forget in spirit — sent
 * directly rather than through wa-webhook.server.ts's `deliver()` since
 * this is a genuine mid-turn message, not part of the turn's own reply;
 * never allowed to block or fail the real answer that follows.
 */
async function nudgeCurating(phone: string, sessionKey: string): Promise<void> {
  try {
    const { sendText } = await import("@/lib/wa-client.server");
    const text = "Good, let me put a couple of options together for you ⏳";
    const waMessageId = await sendText(phone, text);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("wa_messages").insert({
      wa_message_id: waMessageId,
      direction: "outbound",
      session_key: sessionKey,
      kind: "text",
      payload: { text },
    });
  } catch (err) {
    console.error("nudgeCurating failed", err);
  }
}

/**
 * Ported from `offerPackages`. Same logic (`readIntake` → local `buildPackages`
 * fallback → `curatePackages()` best-effort), but the offered set is
 * persisted on the session row instead of `useState`, since the next message
 * may arrive minutes later against a cold request.
 */
async function offerPackages(
  session: SessionState,
  sessionKey: string,
  phone: string,
  text: string,
  recordUser = true,
): Promise<RuntimeResult> {
  const intake = readIntake(text);
  let next = session;
  if (intake.wallCm) {
    next = {
      ...next,
      roomSpec: sanitizeRoomSpec({ wallCm: intake.wallCm, depthCm: intake.depthCm }),
    };
  }

  const fromWall = intake.wallCm ? genericCapacity({ wallCm: intake.wallCm, unit: "ft" }).fits : 0;
  // An explicit count wins over what the wall physically fits — a customer
  // who said "5 stations" gets priced for 5, not silently downgraded to
  // whatever a stated wall length happens to hold at typical spacing.
  // Confirmed live: "How many styling stations - 5" alongside a 10ft wall
  // came back as a 3-station package with no mention 5 was ever asked for,
  // because this used to check the wall-derived figure first.
  const stations =
    intake.stations ||
    fromWall ||
    (intake.budget ? stationsForBudget(intake.budget) : DEFAULT_STATIONS);
  const budget = intake.budget || DEFAULT_BUDGET;
  const note = describeIntake(intake);

  if (recordUser) next = appendTranscript(next, "user", note ? `${text}\n\n(${note})` : text);

  let packages = buildPackages(budget, needsFor(stations));
  const minimum = Math.min(...packages.map((pkg) => pkg.total));
  if (Number.isFinite(minimum) && minimum > budget) {
    const gap = minimum - budget;
    const suggestedStations = Math.max(1, stations - 1);
    const replyText = `A complete ${stations}-station furniture plan currently starts around ${formatPrice(minimum)}, which is ${formatPrice(gap)} above your cap. I won’t label that as “under budget”. Would you like to reduce the station count or change the budget?`;
    const buttons = [
      ...(stations > 1
        ? [
            {
              id: `build:reduce:${suggestedStations}:${budget}`,
              title: `Try ${suggestedStations} stations`,
            },
          ]
        : []),
      { id: "build:change", title: "Change budget" },
      { id: "nav:menu", title: "Main menu" },
    ];
    const finalSession = appendTranscript(next, "assistant", replyText);
    return {
      session: { ...finalSession, flow: { awaiting: "confirm_build" }, offered: null },
      turns: [{ kind: "buttons", text: replyText, action: { kind: "buttons", buttons } }],
    };
  }
  try {
    const [curated] = await Promise.all([
      runCuratePackages(parseCurateInput({ brief: text, stations, budget })),
      nudgeCurating(phone, sessionKey),
    ]);
    if (curated.packages.length) packages = curated.packages;
  } catch {
    /* the local packer is the fallback, not an error worth showing */
  }
  if (!packages.length) return { session: next, turns: [] };

  // Once a budget exceeds what a given station count can absorb, every
  // tier converges on the same maximum set — offering three identical
  // totals under three different names is confusing, not a real choice.
  // Confirmed live: a customer saw "Under budget", "On budget" and
  // "Stretch" all priced at the exact same total with the exact same
  // reason. index.tsx already dedupes this; the WhatsApp port had missed
  // the same call.
  packages = distinctPackages(packages);

  const offered: SessionOffered = {
    packages,
    choice: { stations, budget, note: text, byZone: Boolean(intake.wallCm) },
    at: Date.now(),
  };
  next = { ...next, offered };

  // A single surviving package (distinctPackages collapsed lean/balanced/
  // premium into one) means the budget is bigger than a plan this size
  // actually needs — not that only "one option" exists. Confirmed
  // confusing live: "Under budget" read as an arbitrary label with nothing
  // to contrast it against, and "fullest fit-out" sat right above a total
  // with thousands left unexplained. Both get spelled out here instead of
  // left for the customer to puzzle over.
  const solo = packages.length === 1 ? packages[0] : undefined;
  const leftover = solo ? budget - solo.total : 0;

  const howMany =
    packages.length > 1
      ? `Here are ${packages.length === 2 ? "two" : "three"} ways to do it, each is the most you can get at its price.`
      : `A ${stations}-station salon doesn't need $${budget.toLocaleString("en-US")} of range — here's the fullest fit-out it covers${leftover > 0 ? `, with ${formatPrice(leftover)} left over` : ""}. Say the word and I'll break down exactly what's in it.`;
  const replyText = solo
    ? [
        `${note} ${howMany}`,
        "",
        `*Full fit-out*: ${formatPrice(solo.total)}. ${packageLine(solo)}`,
      ].join("\n")
    : [
        `${note} ${howMany}`,
        "",
        ...packages.map(
          (p) => `*${TIER_LABEL[p.tier]}*: ${formatPrice(p.total)}. ${packageLine(p)}`,
        ),
      ].join("\n");
  next = appendTranscript(next, "assistant", replyText);

  const action: WaAction & { kind: "buttons" } = {
    kind: "buttons",
    buttons: solo
      ? [{ id: `pkg:${solo.tier}`, title: "Show me the plan" }]
      : packages.slice(0, 3).map((p) => ({ id: `pkg:${p.tier}`, title: TIER_LABEL[p.tier] })),
  };

  return { session: next, turns: [{ kind: "buttons", text: replyText, action }] };
}

/** Ported from `acceptPackage`. Sets session.plan instead of setPlanIds/setPlanQty. */
function acceptPackageChoice(
  session: SessionState,
  pkg: Package,
  choice: SessionOfferedChoice,
): RuntimeResult {
  const ids = idsOf(pkg);
  const products = ids.map((id) => getProduct(id)).filter((p): p is FullProduct => Boolean(p));
  if (!products.length) {
    return { session: { ...session, offered: null, rolePicker: null }, turns: [] };
  }

  const qty = Object.fromEntries(pkg.lines.map((line) => [line.product.id, line.qty]));
  let next: SessionState = { ...session, offered: null, rolePicker: null, plan: { ids, qty } };

  const summary = [
    `${choice.stations} station${choice.stations === 1 ? "" : "s"}`,
    formatPrice(pkg.total),
  ].join(" · ");

  const userContent = [
    choice.note,
    `Build me a ${choice.stations}-station salon for about ${formatPrice(choice.budget)}.`,
  ]
    .filter(Boolean)
    .join(" ");
  next = appendTranscript(next, "user", userContent);

  // Itemized, not just narrated. The prose above says what the pieces have
  // in common; a salon owner deciding whether to go ahead needs to see what
  // they actually are — confirmed live: after describing a package by
  // collection and vibe only, the next question was "show me some options
  // of chairs, mirrors, trolleys" because nothing tappable or nameable had
  // been shown at all.
  const itemized = pkg.lines
    .map(
      (line) =>
        `• ${line.qty}× ${line.product.name} — ${formatPrice(line.product.price ?? 0)}${line.qty > 1 ? " each" : ""}`,
    )
    .join("\n");

  // Two sentences, not a run-on of every fact the package data happens to
  // carry. `pkg.reasons` holds the budget delta, the "why" (a model
  // rationale or the deterministic packer's own explanation — see
  // packageLine()), a restatement of the station/piece count the headline
  // and the bullets below already cover, and (rarely) a missing-role note —
  // confirmed live: joining all of them with spaces read as one dense,
  // repetitive paragraph rather than something a person would actually say.
  const replyText = [
    `Here is your plan — ${summary}. ${packageLine(pkg)}`.trim(),
    choice.byZone
      ? "Add a photo of your room and I'll render it zone by zone."
      : "Add a photo of your room and I'll render these into it.",
  ].join(" ");
  next = appendTranscript(next, "assistant", `${replyText}\n\n${itemized}`);

  if (choice.byZone) next = { ...next, pendingZoneRender: true };

  return {
    session: next,
    turns: [{ kind: "text", text: `${replyText}\n\n${itemized}` }, ...productTurns(ids)],
  };
}

// ---------------------------------------------------------------------------
// Focused product picker — customize the three pieces that most define the
// room, while retaining the chosen package's recommended defaults for the
// smaller accessories. Seven consecutive choices produced far too many image
// messages on a phone.
// ---------------------------------------------------------------------------

const money = (amount: number) => `$${Math.round(amount).toLocaleString("en-US")}`;
const CUSTOMIZE_ROLES: readonly Role[] = ["styling", "mirror", "wash"];

function budgetDeltaLine(total: number, budget: number): string {
  const gap = total - budget;
  if (gap > 0) return `${money(gap)} over your ${money(budget)} budget.`;
  if (gap < 0) return `${money(-gap)} under your ${money(budget)} budget.`;
  return `Exactly on your ${money(budget)} budget.`;
}

/** Rebuilds a Package-shaped object from whatever the customer has picked so
 * far — used both to finalize (every role picked) and, defensively, if a
 * picker is abandoned mid-way (picks was seeded with every role's default
 * up front, so it is always a complete, sensible plan even then). */
function packageFromPicks(picks: Record<string, SessionRolePick>, budget: number): Package {
  const lines: Line[] = ROLE_ORDER.map((role) => {
    const pick = picks[role];
    const product = pick ? getProduct(pick.productId) : undefined;
    return product
      ? { role, product, qty: pick!.qty, subtotal: (product.price ?? 0) * pick!.qty }
      : null;
  }).filter((l): l is Line => l !== null);
  const total = lines.reduce((sum, l) => sum + l.subtotal, 0);
  return { tier: "balanced", lines, total, reasons: [budgetDeltaLine(total, budget)] };
}

/**
 * The currently-recommended product for this role, plus a couple of real
 * alternatives priced near it — never the catalogue's full range, which
 * would offer a $3,000 mirror against a $1,500 ask and call it a choice.
 *
 * A WhatsApp list message cannot show an image per row at all — Meta's own
 * platform limit, not a setting — so a text-only list of furniture names
 * asked a customer to guess what a "Panther Barbers Chair" looks like.
 * Confirmed live: "show me images of items, how the hell will I assume
 * from the item name." This sends the actual photo for each option first
 * (the same "product" turn productTurns() already uses for browsing), then
 * a short reply-buttons message to tap one — capped at 3 options rather
 * than the list's 5, both because that's the reply-button limit and
 * because it keeps the number of images sent per step manageable.
 */
function roleChoiceTurns(role: Role, currentId: string, introText: string): WaTurn[] {
  const current = getProduct(currentId);
  const targetPrice = current?.price ?? 0;
  const alternatives = candidatesNear(role, targetPrice, 3).filter((p) => p.id !== currentId);
  const options = [current, ...alternatives]
    .filter((p): p is FullProduct => Boolean(p) && (p?.images.length ?? 0) > 0)
    .slice(0, 3);

  const images: WaTurn[] = options.map((p, i) => ({
    kind: "product",
    imageUrl: p.images[0]!,
    caption: [`*${p.name}*`, `${formatPrice(p.price)}${i === 0 ? " — recommended" : ""}`].join(
      "\n",
    ),
  }));

  const buttons = options.map((p, i) => ({
    id: `role:${role}:${p.id}`,
    title: truncate(`Option ${i + 1} — ${formatPrice(p.price)}`, WA.buttonTitle),
  }));

  return [
    { kind: "text", text: introText },
    ...images,
    { kind: "buttons", text: "Which one?", action: { kind: "buttons", buttons } },
  ];
}

/** Varies the phrasing across steps rather than repeating "Pick your X:"
 * verbatim seven times in a row — confirmed asked for directly: "make sure
 * you are not showing the same things to users again and again." */
function roleStepIntro(index: number, total: number, role: Role): string {
  const label = ROLE_LABEL[role];
  if (index === 0)
    return `Let's pick your pieces one by one. First, your ${label} — a few options:`;
  if (index === total - 1) return `Last one — your ${label}:`;
  return `Now your ${label}:`;
}

/** Seeds the picker with the chosen tier's own defaults for every role (so
 * an abandoned picker still lands on a complete plan — see
 * packageFromPicks), then sends the first role's list message. */
function startRolePicker(
  session: SessionState,
  pkg: Package,
  choice: SessionOfferedChoice,
): RuntimeResult {
  const roles = CUSTOMIZE_ROLES.filter((role) => pkg.lines.some((l) => l.role === role));
  // Nothing to choose between (a one-role plan, or a malformed package) —
  // finalize immediately rather than run a picker with a single option.
  if (roles.length < 2) return acceptPackageChoice(session, pkg, choice);

  const picks: Record<string, SessionRolePick> = {};
  for (const line of pkg.lines) {
    picks[line.role] = { productId: line.product.id, qty: line.qty };
  }

  const rolePicker: SessionRolePicker = {
    choice,
    remainingRoles: roles,
    picks,
    at: Date.now(),
  };

  const firstRole = roles[0]!;
  const intro = `Here is your plan — ${choice.stations} station${choice.stations === 1 ? "" : "s"} · ${formatPrice(pkg.total)}. ${roleStepIntro(0, roles.length, firstRole)}`;
  const turns = roleChoiceTurns(firstRole, picks[firstRole]!.productId, intro);

  const next = appendTranscript(
    { ...session, offered: null, rolePicker },
    "user",
    `Build me a ${choice.stations}-station salon for about ${formatPrice(choice.budget)}.`,
  );
  return { session: next, turns };
}

/** One list reply (`role:<role>:<productId>`) landing mid-picker: record the
 * pick, move to the next role, or finalize once every role has one. */
function handleRolePick(session: SessionState, tappedId: string): RuntimeResult {
  const picker = liveRolePicker(session.rolePicker);
  if (!picker) {
    return {
      session: { ...session, rolePicker: null },
      turns: [
        {
          kind: "text",
          text: "That choice has expired, tell me again what you're after (stations, budget, look) and I'll put together fresh options.",
        },
      ],
    };
  }

  const [, roleRaw, productId] = tappedId.split(":");
  const role = roleRaw as Role | undefined;
  if (!role || !productId || !Object.prototype.hasOwnProperty.call(CATALOG_FULL, productId)) {
    return { session, turns: [] };
  }
  // A stale tap on a role already answered (a slow double-tap, or a reply
  // to a list message that already scrolled past) — the picker only ever
  // moves forward, so this is a no-op rather than reopening a step.
  if (!picker.remainingRoles.includes(role)) return { session, turns: [] };

  const qty = picker.picks[role]?.qty ?? 1;
  const picks = { ...picker.picks, [role]: { productId, qty } };
  const remainingRoles = picker.remainingRoles.filter((r) => r !== role);

  if (!remainingRoles.length) {
    const pkg = packageFromPicks(picks, picker.choice.budget);
    return acceptPackageChoice({ ...session, rolePicker: null }, pkg, picker.choice);
  }

  const totalRoles = CUSTOMIZE_ROLES.filter((role) => picker.picks[role]).length;
  const nextRole = remainingRoles[0]!;
  const nextIndex = totalRoles - remainingRoles.length;
  const intro = roleStepIntro(nextIndex, totalRoles, nextRole);
  const turns = roleChoiceTurns(nextRole, picks[nextRole]!.productId, intro);

  return {
    session: { ...session, rolePicker: { ...picker, picks, remainingRoles, at: Date.now() } },
    turns,
  };
}

/**
 * Ported from `acceptOffer`. The offer is self-describing in the button id
 * (`offer:<mode>:<id1>,<id2>`) rather than looked up from held UI state,
 * since a WhatsApp button reply carries only the id we sent it with.
 */
async function acceptOfferRequest(
  session: SessionState,
  sessionKey: string,
  phone: string,
  tappedId: string,
): Promise<RuntimeResult> {
  const [, mode, idsPart] = tappedId.split(":");
  if (!mode || !isVisualizeMode(mode)) return { session, turns: [] };

  if (mode === "edit") {
    const lastRender = liveLastRender(session.lastRender);
    if (!lastRender) return { session, turns: [] };
    const note = idsPart ? decodeURIComponent(idsPart) : undefined;
    return startEditTurn(session, sessionKey, phone, lastRender, note);
  }
  if (!idsPart) return { session, turns: [] };

  const staged = mode === "staged_room";
  const room = liveRoom(session.room);
  if (!room && !staged) return { session, turns: [] };

  const ids = idsPart
    .split(",")
    .filter((id) => Object.prototype.hasOwnProperty.call(CATALOG_FULL, id));
  const products = ids.map((id) => getProduct(id)).filter((p): p is FullProduct => Boolean(p));
  if (!products.length) return { session, turns: [] };

  return startRenderTurn(
    session,
    sessionKey,
    phone,
    products,
    mode,
    staged ? null : room,
    session.plan.qty,
  );
}

// ---------------------------------------------------------------------------
// add to plan / get a quote — buttons on a delivered render, new code (see
// wa-render-worker.server.ts's renderCtaTurn), since a customer looking at
// their finished picture is the highest-intent moment in the conversation
// and typing "add these to my plan" correctly is not something to require.
// ---------------------------------------------------------------------------

/** id:qty tokens — same convention the RENDER marker itself uses (see
 * chat.functions.ts), reused here since these buttons are built from the
 * same render job's product ids and quantities. */
function parseIdQtyList(raw: string): Array<{ id: string; qty: number }> {
  return raw
    .split(",")
    .map((token) => {
      const [id, qty] = token.split(":");
      return { id: (id ?? "").trim(), qty: qty ? Number.parseInt(qty, 10) : 1 };
    })
    .filter(
      (t): t is { id: string; qty: number } =>
        Boolean(t.id) &&
        Object.prototype.hasOwnProperty.call(CATALOG_FULL, t.id) &&
        Number.isFinite(t.qty) &&
        t.qty > 0,
    );
}

function mergeIntoPlan(plan: SessionPlan, items: Array<{ id: string; qty: number }>): SessionPlan {
  const ids = [...plan.ids];
  const qty = { ...plan.qty };
  for (const item of items) {
    if (!ids.includes(item.id)) ids.push(item.id);
    qty[item.id] = (qty[item.id] ?? 0) + item.qty;
  }
  return { ids, qty };
}

function addToPlanTurn(session: SessionState, tappedId: string): RuntimeResult {
  const items = parseIdQtyList(tappedId.slice("plan:add:".length));
  if (!items.length) return { session, turns: [] };
  const plan = mergeIntoPlan(session.plan, items);
  const names = items
    .map((i) => getProduct(i.id)?.name)
    .filter((n): n is string => Boolean(n))
    .join(", ");
  if (!names) {
    return {
      session: { ...session, plan },
      turns: [{ kind: "text", text: "Added to your plan." }],
    };
  }

  // A running total makes budget planning tangible — the customer sees
  // their spend update in real time as they add things, rather than
  // having to ask separately what their plan comes to.
  const products = plan.ids.map((id) => getProduct(id)).filter((p): p is FullProduct => Boolean(p));
  const lines = linesFrom(products, plan.qty);
  const pieces = planPieces(lines);
  const replyText = `Added ${names} to your plan, now ${pieces} piece${pieces === 1 ? "" : "s"} at ${formatPrice(planTotal(lines))}. Want a quote, or should I keep going?`;
  return { session: { ...session, plan }, turns: [{ kind: "text", text: replyText }] };
}

/** Starts the guided quote intake — the same two fields the web's enquiry
 * form asks for, collected in one message since WhatsApp has no form. */
function startQuoteTurn(session: SessionState, tappedId: string): RuntimeResult {
  const productIds = tappedId
    .slice("quote:".length)
    .split(",")
    .filter((id) => Object.prototype.hasOwnProperty.call(CATALOG_FULL, id));
  if (!productIds.length) return { session, turns: [] };
  const pendingQuote: SessionPendingQuote = { productIds };
  return {
    session: { ...session, pendingQuote, flow: { awaiting: "quote" } },
    turns: [
      {
        kind: "text",
        text: 'What name and email should the quote go to? Send both together, like "Jamie Lee, jamie@lee.com" — add more emails too if you want a partner cc\'d, e.g. "Jamie Lee, jamie@lee.com, partner@biz.com".',
      },
    ],
  };
}

const EMAIL_IN_TEXT = /[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}/g;

/** Accepts the name and one or more emails in any order — a reply to one
 * free-text prompt won't always lead with the same field, and a customer
 * asking for a partner to be copied just adds a second address. */
function parseNameAndEmails(text: string): { name: string; emails: string[] } | null {
  const emails = Array.from(new Set(text.match(EMAIL_IN_TEXT) ?? []));
  if (!emails.length) return null;
  let name = text;
  for (const email of emails) name = name.replace(email, "");
  name = name.replace(/[,]/g, " ").trim();
  return name ? { name, emails } : null;
}

/**
 * Ported concept, new code: the web's enquiry form collects a name and
 * email on one screen and calls submitEnquiry() once per "Enquire" tap;
 * this collects the same two fields in one WhatsApp message instead, then
 * calls the exact same function — once per product, since its schema
 * covers one product per submission and a staged_room render can hold
 * several.
 */
async function submitQuoteTurn(session: SessionState, text: string): Promise<RuntimeResult> {
  const pending = session.pendingQuote;
  if (!pending) return { session: { ...session, flow: INITIAL }, turns: [] };

  const parsed = parseNameAndEmails(text);
  if (!parsed) {
    return {
      session,
      turns: [
        {
          kind: "text",
          text: 'I need both a name and an email to send that through. Could you send them together, like "Jamie Lee, jamie@lee.com"?',
        },
      ],
    };
  }

  const [primaryEmail, ...additionalEmails] = parsed.emails;
  const references: string[] = [];
  for (const id of pending.productIds) {
    try {
      const result = await runSubmitEnquiry(
        parseEnquiryInput({
          productId: id,
          fullName: parsed.name,
          email: primaryEmail!,
          additionalEmails,
        }),
      );
      references.push(result.reference);
    } catch (err) {
      console.error("wa-runtime: submitEnquiry failed", err);
    }
  }

  const next: SessionState = { ...session, pendingQuote: null, flow: INITIAL };
  if (!references.length) {
    return {
      session: next,
      turns: [
        {
          kind: "text",
          text: "Sorry, that didn't go through. Please try again in a moment, or ask to talk to a person.",
        },
      ],
    };
  }

  const who = parsed.emails.join(", ");
  const replyText =
    references.length > 1
      ? `Done, quote requests sent (references ${references.join(", ")}). Someone will follow up at ${who}.`
      : `Done, quote request sent (reference ${references[0]}). Someone will follow up at ${who}.`;
  return { session: next, turns: [{ kind: "text", text: replyText }] };
}

// ---------------------------------------------------------------------------
// chat fallback
// ---------------------------------------------------------------------------

/** Ported from `runChat`. Calls chat.functions.ts's chat() exactly as index.tsx does. */
async function runChatTurn(
  session: SessionState,
  sessionKey: string,
  phone: string,
): Promise<RuntimeResult> {
  const payload: ChatMessageInput[] = session.transcript
    .filter((m) => m.content.trim().length > 0)
    .slice(-12);
  const plan = linesFrom(planProductsOf(session), session.plan.qty);
  const room = liveRoom(session.room);
  const lastRender = liveLastRender(session.lastRender);

  let res;
  try {
    res = await runChatCore(
      parseChatInput({
        messages: payload,
        hasRoomPhoto: room !== null,
        hasRecentRender: lastRender !== null,
        plan,
      }),
    );
  } catch (err) {
    console.error("wa-runtime: chat failed", err);
    return {
      session,
      turns: [{ kind: "text", text: "Sorry, I couldn't get an answer just now. Try that again?" }],
    };
  }

  const next = appendTranscript(session, "assistant", res.text);
  const turns: WaTurn[] = [];

  if (res.offer && (room || res.offer.mode === "staged_room" || res.offer.mode === "edit")) {
    const offer: RenderRequest = res.offer;
    const action: WaAction & { kind: "buttons" } = {
      kind: "buttons",
      buttons: [
        {
          // edit has no product ids to name — "offer:edit:" (empty third
          // segment) is a valid, expected id acceptOfferRequest handles.
          id:
            offer.mode === "edit"
              ? // The note is the whole instruction — with nothing else
                // carrying it, tapping the button would edit nothing.
                // encodeURIComponent keeps it to one colon-free segment,
                // same reasoning as every other id: prefix-parsed by
                // acceptOfferRequest, never trusted as-is.
                `offer:edit:${encodeURIComponent(offer.note ?? "")}`
              : `offer:${offer.mode}:${offer.productIds.join(",")}`,
          // Exactly WA.buttonTitle (20 chars) — "See this in your
          // space" (22) was silently truncated by WhatsApp itself into
          // "See this in your sp…", a real bug a customer flagged.
          title: offer.mode === "edit" ? "Yes, update it" : "See it in your space",
        },
      ],
    };
    turns.push({ kind: "buttons", text: res.text, action });
  } else {
    turns.push({ kind: "text", text: res.text });
  }

  if (res.render?.mode === "edit" && lastRender) {
    const edited = await startEditTurn(next, sessionKey, phone, lastRender, res.render.note);
    // Same reasoning as the products branch below: the reply already says
    // what's being changed, so nothing else needs to follow it here.
    return { session: edited.session, turns: [...turns, ...edited.turns] };
  }

  if (res.render && (room || res.render.mode === "staged_room")) {
    const products = res.render.productIds
      .map((id) => getProduct(id))
      .filter((p): p is FullProduct => Boolean(p));
    if (products.length) {
      // The plan's saved quantities are the default source, but a count
      // named right in this request ("three Oakley chairs") describes this
      // render specifically and was never added to the plan, so it wins for
      // any id it names.
      const quantities = res.render.quantities
        ? { ...session.plan.qty, ...res.render.quantities }
        : session.plan.qty;
      const rendered = await startRenderTurn(
        next,
        sessionKey,
        phone,
        products,
        res.render.mode,
        res.render.mode === "staged_room" ? null : room,
        quantities,
        res.render.note,
      );
      // No product cards here on purpose — a customer just told a render
      // is starting, then immediately shown the same cards again, reads as
      // "that's the whole response" rather than "a render is in progress",
      // a real complaint from live testing. The reply text already named
      // what's being built; the cards would only repeat it.
      return { session: rendered.session, turns: [...turns, ...rendered.turns] };
    }
  }

  // The web app shows a ProductCard per id via ProductStrip; this is the
  // WhatsApp equivalent — one image message per product, right after the
  // reply that named them. Only reached when no render fired above.
  turns.push(...productTurns(res.productIds));

  // Neither an offer nor a render already came with these cards — give the
  // customer a tap instead of leaving the next step to whatever they type.
  if (!res.offer && res.productIds.length) {
    const offerTurn = proactiveOfferTurn(res.productIds);
    if (offerTurn) turns.push(offerTurn);
  }

  return { session: next, turns };
}

// ---------------------------------------------------------------------------
// top-level dispatch — ported from sendTurn
// ---------------------------------------------------------------------------

async function route(
  session: SessionState,
  sessionKey: string,
  phone: string,
  text: string,
  tappedId: string | undefined,
): Promise<RuntimeResult> {
  const command = (tappedId ?? text.replace(/^wa:/i, "")).trim().toLowerCase();

  if (command === "render:status" || /^(check )?render status$/.test(command)) {
    const active = await getActiveRenderState(sessionKey);
    const textOut = active.count
      ? `Your render is active: ${active.generating || active.pending} ${active.generating ? "generating" : "waiting to start"}. I’ll send it here as soon as it is ready.`
      : "You don’t have a render in progress right now.";
    return {
      session,
      turns: [
        {
          kind: "buttons",
          text: textOut,
          action: {
            kind: "buttons",
            buttons: active.count
              ? [
                  { id: "render:cancel", title: "Cancel render" },
                  { id: "nav:menu", title: "Main menu" },
                ]
              : [{ id: "nav:menu", title: "Main menu" }],
          },
        },
      ],
    };
  }

  if (command === "render:cancel" || command === "cancel render" || command === "cancel") {
    const cancelled = await cancelActiveRenderJobs(sessionKey);
    const next = {
      ...session,
      flow: INITIAL,
      offered: null,
      rolePicker: null,
      pendingQuote: null,
      pendingZoneRender: false,
    };
    return {
      session: next,
      turns: [
        {
          kind: "buttons",
          text: cancelled
            ? `Cancelled ${cancelled} active render${cancelled === 1 ? "" : "s"}. What would you like to do next?`
            : "That step is cancelled. There wasn’t an active render to stop.",
          action: {
            kind: "buttons",
            buttons: [
              { id: "visualize", title: "Start a render" },
              { id: "build", title: "Plan my salon" },
              { id: "nav:menu", title: "Main menu" },
            ],
          },
        },
      ],
    };
  }

  if (command === "start over" || command === "restart") {
    await cancelActiveRenderJobs(sessionKey);
    const reply = welcome();
    const reset: SessionState = {
      transcript: [{ role: "assistant", content: reply.text }],
      plan: { ids: [], qty: {} },
      flow: INITIAL,
      roomSpec: null,
      room: null,
      lastRender: null,
      offered: null,
      rolePicker: null,
      pendingZoneRender: false,
      pendingQuote: null,
      handoff: false,
      customerName: session.customerName,
      phoneLast4: session.phoneLast4,
    };
    return {
      session: reset,
      turns: [
        {
          kind: "buttons",
          text: reply.text,
          action: reply.action as WaAction & { kind: "buttons" },
        },
      ],
    };
  }

  if (tappedId === "nav:menu" || command === "menu") {
    const reply = welcome();
    const next = appendTranscript(
      {
        ...session,
        flow: INITIAL,
        offered: null,
        rolePicker: null,
        pendingQuote: null,
        pendingZoneRender: false,
      },
      "assistant",
      reply.text,
    );
    return {
      session: next,
      turns: [
        {
          kind: "buttons",
          text: reply.text,
          action: reply.action as WaAction & { kind: "buttons" },
        },
      ],
    };
  }

  if (tappedId === "build:change") {
    const reply = buildIntake();
    return {
      session: {
        ...appendTranscript(session, "assistant", reply.text),
        flow: { awaiting: "build" },
        offered: null,
      },
      turns: [{ kind: "text", text: reply.text }],
    };
  }

  if (tappedId === "build:confirm") {
    const brief = latestUserText(session);
    if (!brief) {
      const reply = buildIntake();
      return {
        session: { ...session, flow: { awaiting: "build" } },
        turns: [{ kind: "text", text: reply.text }],
      };
    }
    return offerPackages({ ...session, flow: INITIAL }, sessionKey, phone, brief, false);
  }

  if (tappedId?.startsWith("build:reduce:")) {
    const [, , stationsRaw, budgetRaw] = tappedId.split(":");
    const stations = Number.parseInt(stationsRaw ?? "", 10);
    const budget = Number.parseInt(budgetRaw ?? "", 10);
    if (Number.isInteger(stations) && stations >= 1 && Number.isFinite(budget) && budget >= 500) {
      return confirmBuildDetails(
        { ...session, offered: null },
        `${stations} styling stations with a $${budget.toLocaleString("en-US")} furniture budget`,
      );
    }
  }

  // A package tap is answered from what is already on the table, not by the
  // menu and not by the model — the pieces and prices are already decided.
  if (tappedId?.startsWith("pkg:")) {
    const offered = liveOffered(session.offered);
    const pkg = offered?.packages.find((p) => `pkg:${p.tier}` === tappedId);
    if (offered && pkg) return startRolePicker(session, pkg, offered.choice);
    // Stale or unrecognized — the session outlives a browser tab by a lot
    // (30 days vs. one visit), so a tap on an expired offer has to be
    // answered rather than silently dropped.
    return {
      session: { ...session, offered: null, flow: { awaiting: "build" } },
      turns: [
        {
          kind: "text",
          text: "Those options have expired, tell me again what you're after (stations, budget, look) and I'll put together fresh ones.",
        },
      ],
    };
  }

  if (tappedId?.startsWith("offer:")) {
    return acceptOfferRequest(session, sessionKey, phone, tappedId);
  }

  if (tappedId?.startsWith("role:")) {
    return handleRolePick(session, tappedId);
  }

  if (tappedId?.startsWith("plan:add:")) {
    return addToPlanTurn(session, tappedId);
  }

  if (tappedId?.startsWith("quote:")) {
    return startQuoteTurn(session, tappedId);
  }

  // A customer who opens with a complete planning brief should not receive a
  // generic menu and then have to repeat it. Go straight to the confirmation
  // checkpoint when the message contains real planning numbers.
  if (
    !tappedId &&
    !session.flow.awaiting &&
    /\b(salon|station|chair|budget|fit[ -]?out)\b/i.test(text)
  ) {
    const intake = readIntake(text);
    if (intake.stations || intake.budget) return confirmBuildDetails(session, text);
  }

  const step = advance(session.flow, text);

  if (!step) {
    if (session.flow.awaiting === "quote") {
      return submitQuoteTurn(session, text);
    }

    if (session.flow.awaiting === "build") {
      return confirmBuildDetails(session, text);
    }

    if (session.flow.awaiting === "confirm_build") {
      return {
        session,
        turns: [
          {
            kind: "buttons",
            text: "Please choose whether to use those details or change them.",
            action: {
              kind: "buttons",
              buttons: [
                { id: "build:confirm", title: "Use these details" },
                { id: "build:change", title: "Change details" },
                { id: "nav:menu", title: "Main menu" },
              ],
            },
          },
        ],
      };
    }

    if (session.flow.awaiting === "visualize") {
      const parsed = readIntake(text);
      let next = session;
      if (parsed.wallCm) {
        next = {
          ...next,
          roomSpec: sanitizeRoomSpec({ wallCm: parsed.wallCm, depthCm: parsed.depthCm }),
        };
      }
      const note = describeIntake(parsed);
      next = { ...next, flow: INITIAL };
      return runChatTurn(
        appendTranscript(next, "user", note ? `${text}\n\n(${note})` : text),
        sessionKey,
        phone,
      );
    }

    // Splitting the plan across zones is asked for, not offered. Guarded on
    // the plan actually having more than one zone, so a stray "show me each
    // one" can't conjure a multi-image bill out of a single chair.
    if (wantsZoneSplit(text) && isSplittable(planProductsOf(session))) {
      return renderPlanByZoneTurn(appendTranscript(session, "user", text), sessionKey, phone);
    }

    // Any turn can mention the room — "it's 12 by 20 ft" is a perfectly
    // ordinary thing to say three messages in, and it should stick.
    const mentioned = readIntake(text);
    let next = session;
    if (mentioned.wallCm) {
      next = {
        ...next,
        roomSpec: sanitizeRoomSpec({ wallCm: mentioned.wallCm, depthCm: mentioned.depthCm }),
      };
    }
    next = { ...next, flow: INITIAL };
    return runChatTurn(appendTranscript(next, "user", text), sessionKey, phone);
  }

  const { reply } = step;
  const turns: WaTurn[] =
    reply.action?.kind === "buttons"
      ? [
          {
            kind: "buttons",
            text: reply.text,
            action: reply.action as WaAction & { kind: "buttons" },
          },
        ]
      : reply.action?.kind === "list"
        ? [{ kind: "list", text: reply.text, action: reply.action as WaAction & { kind: "list" } }]
        : [{ kind: "text", text: reply.text }];

  // Matches index.tsx's setMessages((prev) => [...prev, outgoing, answer]) —
  // both the tap and the scripted reply join the transcript chat() will
  // later replay, the same as every other branch above.
  let next = appendTranscript(session, "user", text);
  next = appendTranscript(next, "assistant", reply.text);

  return { session: { ...next, flow: step.state }, turns };
}

/** Ported from `send()`'s photo branch. */
async function handlePhoto(
  session: SessionState,
  sessionKey: string,
  phone: string,
  url: string,
  caption: string | undefined,
): Promise<RuntimeResult> {
  const content =
    caption?.trim() || "Here is a photo of my salon. What would you put in this space?";
  let next: SessionState = { ...session, room: { url, at: Date.now() } };
  next = appendTranscript(next, "user", content);

  const active = await getActiveRenderState(sessionKey);
  if (active.count) {
    const turn = renderBusyTurn(active, true);
    return {
      session: appendTranscript(next, "assistant", turn.text),
      turns: [turn],
    };
  }

  // A dimensions run was promised zone renders and was only ever waiting on
  // a photo. Honour that instead of asking the model what to do with it.
  if (next.pendingZoneRender && next.plan.ids.length) {
    next = { ...next, pendingZoneRender: false };
    return renderPlanByZoneTurn(next, sessionKey, phone);
  }

  return runChatTurn(next, sessionKey, phone);
}

/**
 * The only way a turn enters the conversation. Ported from `sendTurn` — the
 * scripted flow (`wa-flow.ts`) gets first refusal and the model is the
 * fallback, not the default.
 */
export async function handleInboundMessage(
  session: SessionState,
  sessionKey: string,
  /** Digits-only WhatsApp number. Never persisted to `session` or the
   * `sessions` table — threaded through only as far as a render enqueue,
   * which is the one place it needs to reach (see wa-phone-crypto.server.ts). */
  phone: string,
  event: InboundEvent,
): Promise<RuntimeResult> {
  if (session.handoff) return { session, turns: [] };

  if (event.kind === "text" && wantsHandoff(event.text)) {
    return { session: { ...session, handoff: true }, turns: [{ kind: "text", text: HANDOFF_ACK }] };
  }

  const working = session;
  const turns: WaTurn[] = [];

  let result: RuntimeResult;
  if (event.kind === "photo") {
    result = await handlePhoto(working, sessionKey, phone, event.url, event.caption);
  } else if (event.kind === "text" || event.kind === "button") {
    const text = event.kind === "button" ? `wa:${event.id}` : event.text.trim();
    if (!text) return { session: working, turns };
    result = await route(
      working,
      sessionKey,
      phone,
      text,
      event.kind === "button" ? event.id : undefined,
    );
  } else {
    result = {
      session: working,
      turns: [
        {
          kind: "text",
          text: "I can read text, taps and photos of your space. Could you try that again?",
        },
      ],
    };
  }

  return { session: result.session, turns: [...turns, ...result.turns] };
}

// Re-exported so wa-webhook.server.ts / a future admin tool can build an
// "expected" list against a job the same way index.tsx's expectedFor() does.
export { expectedFrom };
