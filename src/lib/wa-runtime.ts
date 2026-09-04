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
  distinctPackages,
  idsOf,
  needsFor,
  TIER_LABEL,
  type Package,
} from "@/lib/packages";
import { expectedFrom, linesFrom, planPieces, planTotal, quantitiesFor } from "@/lib/plan";
import { wantsZoneSplit } from "@/lib/render-intent";
import { tooManyRenderRequests } from "@/lib/wa-rate-limit.server";
import { genericCapacity } from "@/lib/room";
import { enqueueRenderJob } from "@/lib/wa-render-jobs.server";
import {
  liveOffered,
  liveRoom,
  sanitizeRoomSpec,
  type SessionOffered,
  type SessionOfferedChoice,
  type SessionPendingQuote,
  type SessionPlan,
  type SessionRoomPhoto,
  type SessionState,
} from "@/lib/wa-session";
import { isMultiReferenceMode, isVisualizeMode, type VisualizeMode } from "@/lib/visualize-prompt";
import { groupByZone, isSplittable } from "@/lib/zones";
import {
  INITIAL,
  advance,
  describeIntake,
  isGreeting,
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
  | { kind: "unsupported" };

export type RuntimeResult = { session: SessionState; turns: WaTurn[] };

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
): Promise<RuntimeResult> {
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
      ? "Refitting your salon with those Comfortel pieces now, please wait ⏳"
      : mode === "staged_room"
        ? "Building that now, please wait ⏳"
        : mode === "lineup"
          ? `Placing ${names.join(", ")} side by side in your space, please wait ⏳`
          : groups.length > 1
            ? `Rendering ${groups.length} options into your space, please wait ⏳`
            : `Rendering the ${entryLabel(mode, groups[0]!)} into your space, please wait ⏳`;

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
  const contentText = `Rendering zone by zone: ${zones}, please wait ⏳`;
  const next = appendTranscript(session, "assistant", contentText);
  return { session: next, turns: [{ kind: "text", text: contentText }] };
}

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

/**
 * Ported from `offerPackages`. Same logic (`readIntake` → local `buildPackages`
 * fallback → `curatePackages()` best-effort), but the offered set is
 * persisted on the session row instead of `useState`, since the next message
 * may arrive minutes later against a cold request.
 */
async function offerPackages(session: SessionState, text: string): Promise<RuntimeResult> {
  const intake = readIntake(text);
  let next = session;
  if (intake.wallCm) {
    next = {
      ...next,
      roomSpec: sanitizeRoomSpec({ wallCm: intake.wallCm, depthCm: intake.depthCm }),
    };
  }

  const fromWall = intake.wallCm ? genericCapacity({ wallCm: intake.wallCm, unit: "ft" }).fits : 0;
  const stations = fromWall || intake.stations || DEFAULT_STATIONS;
  const budget = intake.budget || DEFAULT_BUDGET;
  const note = describeIntake(intake);

  next = appendTranscript(next, "user", note ? `${text}\n\n(${note})` : text);

  let packages = buildPackages(budget, needsFor(stations));
  try {
    const curated = await runCuratePackages(parseCurateInput({ brief: text, stations, budget }));
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

  const howMany =
    packages.length > 1
      ? `Here are ${packages.length === 2 ? "two" : "three"} ways to do it, each is the most you can get at its price.`
      : `Here is the fullest ${stations}-station fit-out the range covers at that budget.`;
  const replyText = [
    `${note} ${howMany}`,
    "",
    ...packages.map(
      (p) => `*${TIER_LABEL[p.tier]}*: ${formatPrice(p.total)}. ${p.reasons[0] ?? ""}`,
    ),
  ].join("\n");
  next = appendTranscript(next, "assistant", replyText);

  const action: WaAction & { kind: "buttons" } = {
    kind: "buttons",
    buttons: packages.slice(0, 3).map((p) => ({ id: `pkg:${p.tier}`, title: TIER_LABEL[p.tier] })),
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
  if (!products.length) return { session: { ...session, offered: null }, turns: [] };

  const qty = Object.fromEntries(pkg.lines.map((line) => [line.product.id, line.qty]));
  let next: SessionState = { ...session, offered: null, plan: { ids, qty } };

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

  const replyText = [
    `Here is the ${TIER_LABEL[pkg.tier].toLowerCase()} package, ${summary}.`,
    ...pkg.reasons,
    choice.byZone
      ? "Add a photo of your room and I'll render it zone by zone."
      : "Add a photo of your room and I'll render these into it.",
  ].join(" ");
  next = appendTranscript(next, "assistant", replyText);

  if (choice.byZone) next = { ...next, pendingZoneRender: true };

  return { session: next, turns: [{ kind: "text", text: replyText }] };
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
  if (!mode || !isVisualizeMode(mode) || !idsPart) return { session, turns: [] };

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

  let res;
  try {
    res = await runChatCore(
      parseChatInput({ messages: payload, hasRoomPhoto: room !== null, plan }),
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

  if (res.offer && (room || res.offer.mode === "staged_room")) {
    const offer: RenderRequest = res.offer;
    const action: WaAction & { kind: "buttons" } = {
      kind: "buttons",
      buttons: [
        {
          id: `offer:${offer.mode}:${offer.productIds.join(",")}`,
          // Exactly WA.buttonTitle (20 chars) — "See this in your
          // space" (22) was silently truncated by WhatsApp itself into
          // "See this in your sp…", a real bug a customer flagged.
          title: "See it in your space",
        },
      ],
    };
    turns.push({ kind: "buttons", text: res.text, action });
  } else {
    turns.push({ kind: "text", text: res.text });
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
  // A package tap is answered from what is already on the table, not by the
  // menu and not by the model — the pieces and prices are already decided.
  if (tappedId?.startsWith("pkg:")) {
    const offered = liveOffered(session.offered);
    const pkg = offered?.packages.find((p) => `pkg:${p.tier}` === tappedId);
    if (offered && pkg) return acceptPackageChoice(session, pkg, offered.choice);
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

  if (tappedId?.startsWith("plan:add:")) {
    return addToPlanTurn(session, tappedId);
  }

  if (tappedId?.startsWith("quote:")) {
    return startQuoteTurn(session, tappedId);
  }

  const step = advance(session.flow, text);

  if (!step) {
    if (session.flow.awaiting === "quote") {
      return submitQuoteTurn(session, text);
    }

    if (session.flow.awaiting === "build") {
      return offerPackages({ ...session, flow: INITIAL }, text);
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

  // The greeting-with-three-buttons is what a customer meets on the web the
  // instant the page opens. WhatsApp has no equivalent of "before any input"
  // — a business number can't message first outside an approved template —
  // so it rides along ahead of the reply to their very first message
  // instead, and (like the web's pre-seeded greetingMessage()) joins the
  // transcript before anything the customer said, so chat() replays history
  // in the same order a browser session would have built it. Skipped when
  // that first message is already a plain greeting: advance() returns the
  // identical welcome() reply for that case on its own, and sending it twice
  // would just be noise.
  const greetFirst = session.transcript.length === 0;
  const alreadyGreeting = event.kind === "text" && isGreeting(event.text.trim());
  let working = session;
  const turns: WaTurn[] = [];
  if (greetFirst && !alreadyGreeting) {
    const hello = welcome();
    working = appendTranscript(working, "assistant", hello.text);
    turns.push({
      kind: "buttons",
      text: hello.text,
      action: hello.action as WaAction & { kind: "buttons" },
    });
  }

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
