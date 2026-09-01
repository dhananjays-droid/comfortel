import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, RefreshCw, Sparkles, SquarePen } from "lucide-react";
import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState } from "react";

import { BrandMark } from "@/components/BrandMark";
import { ChatComposer } from "@/components/ChatComposer";
import { EmptyState } from "@/components/EmptyState";
import { EnquiryDialog, type EnquiryTarget } from "@/components/EnquiryDialog";
import { Markdown } from "@/components/Markdown";
import { ProductCard } from "@/components/ProductCard";
import { ProductSheet } from "@/components/ProductSheet";
import { PlanTray } from "@/components/PlanTray";
import { ProductStrip } from "@/components/ProductStrip";
import { VisualizationMessage, type VisualizationState } from "@/components/VisualizationMessage";
import { PlanWizard, type WizardResult } from "@/components/PlanWizard";
import { WhatsAppView, type WaItem } from "@/components/WhatsAppView";
import type { WaAction } from "@/lib/wa-flow";
import { Switch } from "@/components/ui/switch";
import { VisualizePhotoDialog, type VisualizeRequest } from "@/components/VisualizePhotoDialog";
import { MAX_REFERENCES } from "@/lib/visualize-prompt";
import { groupByZone, isSplittable } from "@/lib/zones";
import { Button } from "@/components/ui/button";
import {
  CATALOG_SLIM,
  categoryLabel,
  formatPrice,
  getProduct,
  type FullProduct,
} from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { chat, type ChatMessageInput, type RenderRequest } from "@/lib/chat.functions";
import { shareDesign } from "@/lib/design.functions";
import { formatLength, planSummary, type RoomSpec } from "@/lib/room";
import { expectedFrom, linesFrom, planPieces, quantitiesFor } from "@/lib/plan";
import { TIER_LABEL, idsOf } from "@/lib/packages";
import { INITIAL, advance, parseWall, welcome, type FlowState } from "@/lib/wa-flow";
import { resizeImage, type ResizedImage } from "@/lib/resize-image";
import { visualizeStart, visualizeStatus } from "@/lib/visualize.functions";
import { inspectRender } from "@/lib/render-qa.functions";
import {
  correctionFor,
  shortfallFrom,
  shortfallNote,
  shouldRetry,
  type Expected,
} from "@/lib/render-qa";
import { isMultiReferenceMode, type VisualizeMode } from "@/lib/visualize-prompt";

const TITLE = "Comfortel — Salon Furniture Assistant";
const DESCRIPTION =
  "Plan a salon, barber or spa fit-out to your budget and your dimensions, then see the pieces rendered into a photo of your own room before you order.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      // The card image is inherited from the root head; only the words differ
      // here, so repeating the image tags would just be another place to drift.
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
    ],
  }),
  component: Index,
});

// ---------------------------------------------------------------------------
// message model
// ---------------------------------------------------------------------------
// Every message carries a plain `content` string, which is what gets replayed
// to the model as history. The rich payloads hang off that so the transcript
// the customer reads and the transcript the model reads never drift apart.

type VisualizeJob = {
  /** One id for the placement modes; several for a refit or a lineup. */
  productIds: string[];
  base64: string;
  mode: VisualizeMode;
  aspectRatio: string;
  /** Which part of the salon this render covers, on a zone render. */
  scene?: string | undefined;
  /** Set only on a retry: the fault the inspector found last time. */
  correction?: string | undefined;
  /**
   * How many of each piece, when this render came from a plan with quantities.
   * Drives both the prompt and the count the finished image is checked against.
   */
  quantities?: Record<string, number> | undefined;
};

/** One render inside a visualization message. A comparison set holds several. */
type RenderEntry = { id: string; vis: VisualizationState; job: VisualizeJob };

type Message =
  /**
   * `display` overrides what the customer sees without changing what the model
   * reads. Used by the dimensions planner, whose message carries worked-out
   * numbers and an instruction not to redo them — useful to the model, noise in
   * a chat bubble.
   */
  | { id: string; role: "user"; kind: "text"; content: string; display?: string | undefined }
  | {
      id: string;
      role: "user";
      kind: "photo";
      content: string;
      photo: string;
      productId: string;
    }
  | {
      id: string;
      role: "assistant";
      kind: "text";
      content: string;
      productIds?: string[];
      /** Reply buttons or a list, when this turn came from the WhatsApp menu. */
      action?: WaAction | undefined;
      /**
       * A render the model wanted to run on a turn that did not ask for one.
       * Shown as a button rather than spent — see render-intent.ts.
       */
      offer?: RenderRequest | undefined;
    }
  | {
      id: string;
      role: "assistant";
      kind: "visualization";
      content: string;
      entries: RenderEntry[];
    }
  | {
      id: string;
      role: "assistant";
      kind: "receipt";
      content: string;
      reference: string;
      productId: string;
    };

const POLL_INTERVAL_MS = 3000;

/**
 * 100 x 3s = 5 minutes. GPT Image 2 renders measured at 80-98s, against the old
 * 40-poll (120s) ceiling — close enough that a slow render would have shown the
 * customer a timeout for an image kie had generated and charged us for. The
 * window costs nothing when renders are fast; it only has to outlast the worst.
 */
const MAX_POLLS = 100;
const STORAGE_KEY = "comfortel.chat.v1";
/**
 * The plan is stored beside the thread, not inside it.
 *
 * The transcript survived a reload and the plan did not, so a refreshed page
 * showed a message promising a $14,788 package above an empty tray — and, now
 * that the model is told the plan every turn, it would have been told the
 * customer owns nothing while the conversation above it says otherwise. Ids and
 * counts only: the catalogue is already in the bundle.
 */
const PLAN_KEY = "comfortel.plan.v1";
/** Survives reloads so a demo stays in the mode it was left in. */
const WA_MODE_KEY = "comfortel.whatsapp.v1";

/**
 * WhatsApp Mode is parked.
 *
 * Everything behind it still builds and is still covered by tests
 * (`wa-flow.test.ts`, `whatsapp.test.ts`) — this flag only removes the header
 * toggle and the alternate surface, so nothing half-finished reaches anyone.
 * Flip to true to bring it back; no other change is needed.
 */
const WHATSAPP_MODE_ENABLED = false;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

let seq = 0;
const nextId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The customer's salon photo, held for the session so later turns can reuse it. */
type RoomPhoto = { image: ResizedImage; preview: string };

/** How many individual pieces a render covers, as opposed to how many products. */
function pieceCount(
  products: FullProduct[],
  quantities: Record<string, number> | undefined,
): number {
  return planPieces(linesFrom(products, quantities));
}

/** What the finished image will be counted against. Empty when nothing repeats. */
function expectedFor(job: VisualizeJob): Expected[] {
  if (!job.quantities) return [];
  const products = job.productIds
    .map((id) => getProduct(id))
    .filter((p): p is FullProduct => Boolean(p));
  return expectedFrom(linesFrom(products, job.quantities));
}

/**
 * Turns a render request into one assistant message.
 *
 * refit_room and lineup each produce a SINGLE image from several product
 * references. The placement modes render one image per product, which is the
 * only way to get a true A/B — the same position occupied by each candidate in
 * turn — and is why they cost one generation each.
 */
/**
 * A zone-split render: one image per salon zone, from one plan and one photo.
 *
 * Each zone becomes its own entry, and entries already render in parallel and
 * poll independently, so the split costs wall-clock nothing beyond the slowest
 * zone. It costs one generation per zone, which is why it is opt-in.
 */
function buildZoneRenderMessage(
  groups: Array<{ zone: string; label: string; scene: string; products: FullProduct[] }>,
  photo: RoomPhoto,
  quantities?: Record<string, number> | undefined,
): { message: Message; entries: RenderEntry[] } {
  const entries: RenderEntry[] = groups.map((group) => {
    const ids = group.products.map((p) => p.id);
    const qty = quantitiesFor("refit_room", ids, quantities);
    return {
      id: nextId(),
      job: {
        productIds: ids,
        base64: photo.image.base64,
        mode: "refit_room" as VisualizeMode,
        aspectRatio: photo.image.aspectRatio,
        scene: group.scene,
        ...(qty ? { quantities: qty } : {}),
      },
      vis: {
        productIds: ids,
        label: group.label,
        before: photo.preview,
        status: "loading",
      },
    };
  });

  return {
    message: { id: nextId(), role: "assistant", kind: "visualization", content: "", entries },
    entries,
  };
}

/**
 * Re-express the transcript in WhatsApp's primitives.
 *
 * Product suggestions become a list message, renders become image messages, and
 * everything else is a plain bubble. Kept as a pure function of the message list
 * so the two views can never drift into telling different stories.
 */
function toWaItems(messages: Message[]): WaItem[] {
  return messages.map((message): WaItem => {
    if (message.role === "user") {
      if (message.kind === "photo" && message.photo) {
        return {
          id: message.id,
          from: "me",
          kind: "image",
          text: message.content,
          src: message.photo,
        };
      }
      return {
        id: message.id,
        from: "me",
        kind: "text",
        text: message.kind === "text" && message.display ? message.display : message.content,
      };
    }

    if (message.kind === "visualization") {
      return {
        id: message.id,
        from: "them",
        kind: "renders",
        text: message.content,
        renders: message.entries.map((entry) => ({
          label: entry.vis.label,
          url: entry.vis.imageUrl,
          loading: entry.vis.status === "loading",
        })),
      };
    }

    if (message.kind === "text" && message.productIds?.length) {
      const products = message.productIds
        .map((id) => getProduct(id))
        .filter((p): p is FullProduct => Boolean(p));
      if (products.length) {
        return { id: message.id, from: "them", kind: "products", text: message.content, products };
      }
    }

    return {
      id: message.id,
      from: "them",
      kind: "text",
      text: message.content,
      ...(message.kind === "text" && message.action ? { action: message.action } : {}),
    };
  });
}

function buildRenderMessage(
  mode: VisualizeMode,
  productIds: string[],
  photo: RoomPhoto,
  quantities?: Record<string, number> | undefined,
): { message: Message; entries: RenderEntry[] } {
  const base = {
    base64: photo.image.base64,
    mode,
    aspectRatio: photo.image.aspectRatio,
  };

  // refit_room and lineup are ONE image built from several references. Every
  // other mode renders each product separately, which is what a true A/B needs
  // and is why it costs one generation per product.
  const groups: string[][] = isMultiReferenceMode(mode)
    ? [productIds]
    : productIds.map((id) => [id]);

  const entries: RenderEntry[] = groups.map((ids) => {
    const qty = quantitiesFor(mode, ids, quantities);
    return {
      id: nextId(),
      job: { ...base, productIds: ids, ...(qty ? { quantities: qty } : {}) },
      vis: {
        productIds: ids,
        label:
          mode === "refit_room"
            ? "Your salon, refitted"
            : mode === "lineup"
              ? `${ids.length} options in your space`
              : (getProduct(ids[0]!)?.name ?? "Your render"),
        before: photo.preview,
        status: "loading",
      },
    };
  });

  const names = productIds.map((id) => getProduct(id)?.name).filter(Boolean);
  const content =
    mode === "refit_room"
      ? "Here is your salon refitted with those Comfortel pieces."
      : mode === "lineup"
        ? // Naming them in order is what makes the single image readable — without
          // it the customer cannot tell which chair is which.
          `Here they are in your space, left to right: ${names.join(", ")}.`
        : entries.length > 1
          ? `Here are ${entries.length} options rendered into your space.`
          : `Here is the ${entries[0]?.vis.label} rendered into your space.`;

  return {
    message: { id: nextId(), role: "assistant", kind: "visualization", content, entries },
    entries,
  };
}

function Index() {
  const sendChat = useServerFn(chat);
  const startVisualize = useServerFn(visualizeStart);
  const pollVisualize = useServerFn(visualizeStatus);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [sheetProduct, setSheetProduct] = useState<FullProduct | null>(null);
  const [photoProducts, setPhotoProducts] = useState<FullProduct[]>([]);
  /**
   * The plan: ids the customer wants rendered together. Ids rather than
   * products so it survives sessionStorage without duplicating the catalogue.
   */
  const [planIds, setPlanIds] = useState<string[]>([]);

  /**
   * How many of each piece the plan covers.
   *
   * The plan itself stays a list of ids because that is what a render needs —
   * one reference image per product, not four. But a package says "4 styling
   * chairs", and a tray that totalled one of each showed $5,962 under a message
   * promising $14,788. Two prices for the same plan reads as a lie.
   */
  const [planQty, setPlanQty] = useState<Record<string, number>>({});

  const planProducts = planIds
    .map((id) => getProduct(id))
    .filter((p): p is FullProduct => Boolean(p));

  /**
   * The plan survives rendering — you should be able to add a piece and go
   * again without rebuilding it — so the tray needs its own notion of being out
   * of the way. Collapsed while a render runs, reopened the moment the plan
   * changes, since changing it is the only reason to want it back.
   */
  /**
   * The plan, readable from a callback without making that callback depend on
   * it. runChat is memoised and is also re-invoked by the retry button from a
   * history captured earlier; closing over the plan directly would send a stale
   * one, and adding it to the deps would rebuild the callback on every tap of
   * the tray.
   */
  const planIdsRef = useRef<string[]>(planIds);
  const planQtyRef = useRef<Record<string, number>>(planQty);
  useEffect(() => {
    planIdsRef.current = planIds;
    planQtyRef.current = planQty;
  }, [planIds, planQty]);

  const [planCollapsed, setPlanCollapsed] = useState(false);
  const [wizard, setWizard] = useState(false);
  /**
   * A dimensions run promised one image per zone. The photo usually arrives
   * after the package, so the intent is held here and spent when it does.
   */
  const [pendingZoneRender, setPendingZoneRender] = useState(false);
  /**
   * Renders the same conversation as WhatsApp would deliver it. Read from
   * storage in an effect rather than in the initialiser: this route is server
   * rendered, and touching localStorage during render would mismatch hydration.
   */
  const [whatsapp, setWhatsapp] = useState(false);
  /** The only thing the UI should branch on — the flag can't be missed here. */
  const waMode = WHATSAPP_MODE_ENABLED && whatsapp;
  /** Where the scripted WhatsApp menu is up to. Reset with the thread. */
  const [flow, setFlow] = useState<FlowState>(INITIAL);

  useEffect(() => {
    if (!WHATSAPP_MODE_ENABLED) return;
    try {
      setWhatsapp(localStorage.getItem(WA_MODE_KEY) === "1");
    } catch {
      /* private mode and blocked storage both just mean the default */
    }
  }, []);

  const toggleWhatsapp = useCallback((next: boolean) => {
    setWhatsapp(next);
    try {
      localStorage.setItem(WA_MODE_KEY, next ? "1" : "0");
    } catch {
      /* the toggle still works for this session */
    }
  }, []);

  const togglePlan = useCallback((product: FullProduct) => {
    setPlanCollapsed(false);
    setPlanQty((prev) => {
      const { [product.id]: _dropped, ...rest } = prev;
      return rest;
    });
    setPlanIds((prev) =>
      prev.includes(product.id)
        ? prev.filter((id) => id !== product.id)
        : prev.length >= MAX_REFERENCES
          ? prev
          : [...prev, product.id],
    );
  }, []);
  const [enquiry, setEnquiry] = useState<EnquiryTarget | null>(null);

  // Attached in the composer but not yet sent.
  const [pendingPhoto, setPendingPhoto] = useState<RoomPhoto | null>(null);
  const [photoLoading, setPhotoLoading] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  /** WhatsApp mode replaces ChatComposer, so it needs its own file input. */
  const waFileRef = useRef<HTMLInputElement>(null);
  const lastHistoryRef = useRef<{ history: Message[]; photoAttached: boolean } | null>(null);
  // A ref, not state: runChat reads it in the same tick that send() sets it.
  const roomPhotoRef = useRef<RoomPhoto | null>(null);
  /**
   * Mirrors whether roomPhotoRef holds anything. The ref stays a ref because
   * send() reads it in the same tick it is set; this state exists so the plan
   * tray actually re-renders when a photo arrives, rather than showing a stale
   * label until some unrelated update happens to flush it.
   */
  const [hasRoomPhoto, setHasRoomPhoto] = useState(false);

  // ---- session persistence ------------------------------------------------
  // Room photos are megabyte-scale data URLs, so they are dropped on the way
  // into storage rather than blowing the quota. A rehydrated render still shows
  // its result; only the before/after toggle is unavailable.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) setMessages(JSON.parse(raw) as Message[]);
    } catch {
      /* a corrupt or unavailable store just means an empty thread */
    }
    try {
      const raw = sessionStorage.getItem(PLAN_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { ids?: unknown; qty?: unknown };
      // Filtered against the catalogue on the way back in: a stored id that no
      // longer resolves would sit in the plan as an invisible line, counted in
      // the subtotal and sent to the model, with no card to remove it by.
      const ids = Array.isArray(saved.ids)
        ? saved.ids.filter((id): id is string => typeof id === "string" && Boolean(getProduct(id)))
        : [];
      if (!ids.length) return;
      setPlanIds(ids.slice(0, MAX_REFERENCES));
      const qty = saved.qty;
      if (qty && typeof qty === "object") {
        setPlanQty(
          Object.fromEntries(
            Object.entries(qty as Record<string, unknown>)
              .filter(([id, n]) => ids.includes(id) && Number.isFinite(Number(n)) && Number(n) > 1)
              .map(([id, n]) => [id, Math.round(Number(n))]),
          ),
        );
      }
    } catch {
      /* same again — an unreadable plan is an empty one */
    }
  }, []);

  useEffect(() => {
    try {
      if (planIds.length) {
        sessionStorage.setItem(PLAN_KEY, JSON.stringify({ ids: planIds, qty: planQty }));
      } else {
        sessionStorage.removeItem(PLAN_KEY);
      }
    } catch {
      /* over quota or storage disabled — the plan still works in memory */
    }
  }, [planIds, planQty]);

  useEffect(() => {
    try {
      const persistable = messages
        .filter((m, i) => {
          // An unfinished render can't be resumed after a reload, so it is not
          // stored — and neither is the photo request that produced it, or the
          // rehydrated thread would show a question with no answer.
          if (m.kind === "visualization") return m.entries.every((e) => e.vis.status === "done");
          if (m.kind === "photo") {
            const reply = messages[i + 1];
            return (
              reply?.kind !== "visualization" || reply.entries.every((e) => e.vis.status === "done")
            );
          }
          return true;
        })
        .map((m) => {
          if (m.kind === "photo") return { ...m, photo: "" };
          if (m.kind === "visualization") {
            return {
              ...m,
              entries: m.entries.map((e) => ({
                ...e,
                vis: { ...e.vis, before: "" },
                job: { ...e.job, base64: "" },
              })),
            };
          }
          return m;
        });
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch {
      /* over quota or storage disabled — the thread still works in memory */
    }
  }, [messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, thinking]);

  const patchRender = useCallback((entryId: string, patch: Partial<VisualizationState>) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === "visualization"
          ? {
              ...m,
              entries: m.entries.map((e) =>
                e.id === entryId ? { ...e, vis: { ...e.vis, ...patch } } : e,
              ),
            }
          : m,
      ),
    );
  }, []);

  // ---- render -------------------------------------------------------------
  const runInspect = useServerFn(inspectRender);

  /**
   * Check a finished render, and re-run it once if something basic is broken.
   *
   * The generator places furniture plausibly but models no collision, so it will
   * happily bury a styling chair in a wall panel and call it done. The prompt
   * now forbids that explicitly, which is the real fix; this is the net under it.
   *
   * Deliberately silent to the customer: a caught fault shows as the render
   * simply taking longer, not as an error. They asked for a picture of their
   * salon, not a report on our retry logic.
   */
  const finish = useCallback(
    async (entry: RenderEntry, imageUrl: string, attempt: number) => {
      try {
        const expected = expectedFor(entry.job);
        const verdict = await runInspect({ data: { imageUrl, expected } });

        if (shouldRetry(verdict, attempt)) {
          patchRender(entry.id, { status: "loading", progress: 0 });
          void runRenderRef.current?.(
            { ...entry, job: { ...entry.job, correction: correctionFor(verdict) } },
            attempt + 1,
          );
          return;
        }

        // A room that holds two stations holds two however many times we pay
        // for the picture, so a shortfall is explained rather than re-rendered.
        // Saying where the rest would go is the useful half: it turns a missing
        // chair into a fact about their floor plan.
        const note = shortfallNote(shortfallFrom(expected, verdict), verdict.elsewhere);
        patchRender(entry.id, { status: "done", imageUrl, ...(note ? { note } : {}) });
        return;
      } catch {
        // An inspection we could not run is not a reason to withhold the image.
      }
      patchRender(entry.id, { status: "done", imageUrl });
    },
    [patchRender, runInspect],
  );

  // runRender and finish call each other, so one of them has to be reached
  // through a ref rather than a closure captured before the other exists.
  const runRenderRef = useRef<((entry: RenderEntry, attempt?: number) => Promise<void>) | null>(
    null,
  );

  const runRender = useCallback(
    async (entry: RenderEntry, attempt = 0) => {
      const { id, job } = entry;
      patchRender(id, { status: "loading", progress: 0, error: undefined });
      try {
        const started = await startVisualize({
          data: {
            productIds: job.productIds,
            roomImageBase64: job.base64,
            mode: job.mode,
            aspectRatio: job.aspectRatio,
            ...(job.scene ? { scene: job.scene } : {}),
            ...(job.correction ? { correction: job.correction } : {}),
            ...(job.quantities ? { quantities: job.quantities } : {}),
          },
        });

        if (started.imageUrl) {
          await finish(entry, started.imageUrl, attempt);
          return;
        }
        if (!started.taskId) throw new Error("no task id");

        // `poll`, not `attempt`: this loop used to shadow the retry counter, so
        // finish() was handed the poll index — around 28 on a normal render —
        // and shouldRetry compared that against MAX_RETRIES of 1. The check ran
        // on every image and the retry could never once fire.
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const res = await pollVisualize({ data: { taskId: started.taskId } });
          if (res.done && res.imageUrl) {
            await finish(entry, res.imageUrl, attempt);
            return;
          }
          patchRender(id, { progress: res.progress ?? 0 });
        }
        patchRender(id, {
          status: "error",
          error: "This is taking longer than expected. Please try again.",
        });
      } catch {
        patchRender(id, {
          status: "error",
          error: "We couldn't place that piece in your space just now.",
        });
      }
    },
    [patchRender, pollVisualize, startVisualize, finish],
  );

  // Closes the loop between runRender and finish, which call each other.
  useEffect(() => {
    runRenderRef.current = runRender;
  }, [runRender]);

  // ---- chat ---------------------------------------------------------------
  const runChat = useCallback(
    async (history: Message[], photoAttached: boolean) => {
      setThinking(true);
      setChatError(null);
      lastHistoryRef.current = { history, photoAttached };
      try {
        const payload: ChatMessageInput[] = history
          .filter((m) => m.content.trim().length > 0)
          .slice(-12)
          .map((m) => ({ role: m.role, content: m.content }));

        // The plan goes with every turn, not just the turn it changed on. The
        // transcript still contains whatever package was proposed earlier, in
        // full, and the model has no other way to know two pieces have since
        // been taken out of it. Read from state here rather than from the
        // message history for exactly that reason.
        const plan = linesFrom(
          planIdsRef.current
            .map((id) => getProduct(id))
            .filter((p): p is FullProduct => Boolean(p)),
          planQtyRef.current,
        );

        const res = await sendChat({
          data: { messages: payload, hasRoomPhoto: photoAttached, plan },
        });

        const next: Message[] = [
          ...history,
          {
            id: nextId(),
            role: "assistant",
            kind: "text",
            content: res.text,
            productIds: res.productIds,
            // Offered, not spent: the model asked to render on a turn that did
            // not ask for one, so it becomes a button the customer can decline
            // by simply not tapping it.
            ...(res.offer && roomPhotoRef.current ? { offer: res.offer } : {}),
          },
        ];

        // The assistant can ask for renders itself. It only ever gets here when
        // a photo is attached — the server refuses to parse the marker otherwise.
        const photo = roomPhotoRef.current;
        if (res.render && photo) {
          // The plan's quantities travel with it: when the model renders the
          // plan — which is what it is told to do for "show me these" — the
          // picture has to hold the number the tray and the quote say.
          const { message, entries } = buildRenderMessage(
            res.render.mode,
            res.render.productIds,
            photo,
            planQtyRef.current,
          );
          if (entries.length) {
            next.push(message);
            setMessages(next);
            entries.forEach((entry) => void runRender(entry));
            return;
          }
        }

        setMessages(next);
      } catch (err) {
        setChatError(err instanceof Error ? err.message : "CHAT_FAILED");
      } finally {
        setThinking(false);
      }
    },
    [sendChat, runRender],
  );

  /**
   * @param display What to show in the bubble, when that differs from the text
   *   the model should receive.
   */
  function send(text: string, display?: string) {
    const trimmed = text.trim();
    if (thinking) return;
    // A photo on its own is a valid message, and so is text on its own.
    if (!trimmed && !pendingPhoto) return;

    const attached = pendingPhoto;
    // The attached photo becomes the session's room photo, so later turns can
    // render into it without the customer re-uploading.
    if (attached) {
      roomPhotoRef.current = attached;
      setHasRoomPhoto(true);
    }

    const content = trimmed || "Here is a photo of my salon. What would you put in this space?";

    const next: Message[] = [
      ...messages,
      attached
        ? {
            id: nextId(),
            role: "user",
            kind: "photo",
            content,
            photo: attached.preview,
            productId: "",
          }
        : {
            id: nextId(),
            role: "user",
            kind: "text",
            content,
            ...(display ? { display } : {}),
          },
    ];
    setMessages(next);
    setInput("");
    setPendingPhoto(null);

    // A dimensions run was promised zone renders and was only ever waiting on a
    // photo. Honour that instead of asking the model what to do with it.
    if (attached && pendingZoneRender && planIds.length) {
      setPendingZoneRender(false);
      renderPlanByZone(next);
      return;
    }

    void runChat(next, roomPhotoRef.current !== null);
  }

  /**
   * The customer tapped a render the model had only offered.
   *
   * Routed through startRender, the same path the card button and the photo
   * dialog use, so an accepted offer is indistinguishable from having asked in
   * the first place — including the "Show me the X in my space" turn it writes
   * into the thread, which keeps the transcript honest about who asked.
   */
  function acceptOffer(offer: RenderRequest) {
    const photo = roomPhotoRef.current;
    if (!photo) return;
    const products = offer.productIds
      .map((id) => getProduct(id))
      .filter((p): p is FullProduct => Boolean(p));
    if (!products.length) return;
    startRender(products, offer.mode, photo, planQtyRef.current);
  }

  const pickPhoto = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("That file isn't an image", { description: "Pick a photo of your space." });
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      toast("That photo is over 10MB", { description: "Try a smaller one." });
      return;
    }
    setPhotoLoading(true);
    try {
      const image = await resizeImage(file);
      setPendingPhoto({ image, preview: `data:image/jpeg;base64,${image.base64}` });
    } catch {
      toast("We couldn't read that photo", { description: "Try a different one." });
    } finally {
      setPhotoLoading(false);
    }
  }, []);

  /**
   * Kick off a render against a room photo we already hold.
   *
   * Split out of acceptPhoto so changing the plan and rendering again does not
   * ask for the photo a second time: the room is already resized and, on the
   * server, already uploaded to kie. Re-asking for it was the main reason
   * comparing options felt like starting over.
   */
  function startRender(
    products: FullProduct[],
    mode: VisualizeMode,
    photo: RoomPhoto,
    quantities?: Record<string, number> | undefined,
  ) {
    const verb =
      mode === "add" ? "into" : mode === "replace_all" ? "throughout" : "in place of what's in";

    const ids = products.map((p) => p.id);
    const { message, entries } = buildRenderMessage(mode, ids, photo, quantities);

    // The render is the thing they just asked to look at; the tray must not sit
    // on top of it.
    setPlanCollapsed(true);

    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: "user",
        kind: "photo",
        content:
          products.length > 1
            ? `Fit my space out with these ${pieceCount(products, quantities)} pieces.`
            : `Show me the ${products[0]?.name ?? "this piece"} ${verb} my space.`,
        photo: photo.preview,
        productId: ids[0] as string,
      },
      message,
    ]);
    entries.forEach((entry) => void runRender(entry));
  }

  function acceptPhoto(request: VisualizeRequest) {
    setPhotoProducts([]);
    const photo: RoomPhoto = { image: request.image, preview: request.preview };
    roomPhotoRef.current = photo;
    setHasRoomPhoto(true);
    startRender(request.products, request.mode, photo);
  }

  const runShare = useServerFn(shareDesign);

  /**
   * Share every finished render in one message, plus the products behind them.
   *
   * Unfinished renders are excluded rather than shared as blanks, and if none
   * have finished there is nothing worth a link yet.
   */
  const shareRenders = useCallback(
    async (entries: RenderEntry[]) => {
      const renders = entries
        .filter((e) => e.vis.status === "done" && e.vis.imageUrl)
        .map((e) => ({ imageUrl: e.vis.imageUrl as string, label: e.vis.label }));

      if (!renders.length) {
        toast("Nothing to share yet", { description: "Wait for the render to finish." });
        return;
      }

      const ids = [...new Set(entries.flatMap((e) => e.vis.productIds))];
      const subtotal = ids.reduce((sum, id) => sum + (getProduct(id)?.price ?? 0), 0);

      try {
        const { code } = await runShare({
          data: { productIds: ids, renders, subtotalCents: subtotal },
        });
        const url = `${window.location.origin}/d/${code}`;
        try {
          await navigator.clipboard.writeText(url);
          toast("Link copied", { description: url });
        } catch {
          // Clipboard access is denied in plenty of contexts; the link is the
          // point, so show it rather than failing the whole share.
          toast("Your share link", { description: url });
        }
      } catch {
        toast("Couldn't create a share link", { description: "Please try again." });
      }
    },
    [runShare],
  );

  /**
   * Render the plan as one image per salon zone.
   *
   * Costs one generation per zone, so it is a separate button rather than
   * something that happens automatically — the customer decides when a cluttered
   * single frame is worth splitting.
   */
  function renderPlanByZone(history?: Message[]) {
    if (!planProducts.length) return;
    const photo = roomPhotoRef.current;
    if (!photo) {
      setPhotoProducts(planProducts);
      return;
    }

    const groups = groupByZone(planProducts);
    const { message, entries } = buildZoneRenderMessage(groups, photo, planQty);
    setPlanCollapsed(true);

    // When the photo message is already in `history` the room shot is on screen,
    // so this only adds the render itself rather than a duplicate photo bubble.
    if (history) {
      setMessages([...history, message]);
    } else {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "user",
          kind: "photo",
          content: `Show me my space zone by zone — ${groups.map((g) => g.label.toLowerCase()).join(", ")}.`,
          photo: photo.preview,
          productId: planProducts[0]?.id ?? "",
        },
        message,
      ]);
    }
    entries.forEach((entry) => void runRender(entry));
  }

  /**
   * The plan's render button. Reuses the room photo when we have one so that
   * adding a piece and looking again is one click, not another upload.
   */
  function renderPlan() {
    if (!planProducts.length) return;
    const photo = roomPhotoRef.current;
    if (!photo) {
      setPhotoProducts(planProducts);
      return;
    }
    startRender(
      planProducts,
      planProducts.length > 1 ? "refit_room" : "replace_all",
      photo,
      planQty,
    );
  }

  /**
   * A chosen package becomes the plan, and then a render.
   *
   * The package is already decided in code — real products, real prices — so
   * this does not ask the model what to buy. It states the outcome, fills the
   * plan, and lets the customer edit it or render it straight away. The room
   * photo is optional: without one we still show the list and offer the upload.
   */
  function acceptPackage(result: WizardResult) {
    const ids = idsOf(result.pkg).slice(0, MAX_REFERENCES);
    const products = ids.map((id) => getProduct(id)).filter((p): p is FullProduct => Boolean(p));
    if (!products.length) return;

    setWizard(false);
    setPlanIds(ids);
    setPlanQty(Object.fromEntries(result.pkg.lines.map((line) => [line.product.id, line.qty])));
    setPlanCollapsed(false);

    const summary = [
      `${result.stations} station${result.stations === 1 ? "" : "s"}`,
      formatPrice(result.pkg.total),
    ].join(" · ");

    const said: Message = {
      id: nextId(),
      role: "user",
      kind: "text",
      content: [
        result.note,
        `Build me a ${result.stations}-station salon for about ${formatPrice(result.budget)}.`,
      ]
        .filter(Boolean)
        .join(" "),
      display: result.note || `A ${result.stations}-station salon — ${summary}`,
    };

    const answer: Message = {
      id: nextId(),
      role: "assistant",
      kind: "text",
      content: [
        `Here is the ${TIER_LABEL[result.pkg.tier].toLowerCase()} package — ${summary}.`,
        ...result.pkg.reasons,
        result.byZone
          ? "Add a photo of your room and I'll render it zone by zone."
          : "Add a photo of your room and I'll render these into it.",
      ].join(" "),
      productIds: ids,
    };

    setMessages((prev) => [...prev, said, answer]);

    // Dimensions runs end in one image per zone, which is the whole point of
    // giving us the room rather than a sentence.
    if (result.byZone) setPendingZoneRender(true);
  }

  /**
   * Send, the WhatsApp way.
   *
   * A business number answers "Hi" from a script, instantly and for free — only
   * a sentence the menu cannot serve is worth a model call. So the scripted flow
   * gets first refusal, and `send` is the fallback rather than the default.
   *
   * @param tapped An option id from a reply button or list row, when the
   *   customer tapped rather than typed.
   */
  function sendWhatsApp(raw: string, tapped?: string) {
    const text = tapped ? `wa:${tapped}` : raw.trim();
    if (!text || thinking) return;

    const shown = tapped ? labelFor(tapped, raw) : text;
    const outgoing: Message = {
      id: nextId(),
      role: "user",
      kind: "text",
      content: text,
      display: shown,
    };

    const step = advance(flow, text);

    // Nothing scripted fits — hand the turn to the model, but keep the room
    // measurement in the words the model needs if that is what this was.
    if (!step) {
      const metres = flow.awaiting === "wall" ? parseWall(text) : null;
      setFlow(INITIAL);
      setInput("");
      if (metres !== null) {
        const spec: RoomSpec = { wallCm: metres * 100, unit: "m" };
        const next = [
          ...messages,
          { ...outgoing, content: planSummary(spec), display: shown } as Message,
        ];
        setMessages(next);
        void runChat(next, roomPhotoRef.current !== null);
        return;
      }
      const next = [...messages, outgoing];
      setMessages(next);
      void runChat(next, roomPhotoRef.current !== null);
      return;
    }

    const { reply } = step;
    setFlow(step.state);
    setInput("");

    // A category pick is answered from the catalogue, not the model.
    const productIds = reply.category
      ? CATALOG_SLIM.filter((p) => p.c === reply.category)
          .slice(0, MAX_REFERENCES)
          .map((p) => p.id)
      : [];

    const answer: Message = {
      id: nextId(),
      role: "assistant",
      kind: "text",
      content: reply.category
        ? `Here is what we have in ${categoryLabel(reply.category).toLowerCase()}s. Tap a piece for details, or send me a photo of your room and I'll put one in it.`
        : reply.text,
      ...(productIds.length ? { productIds } : {}),
      ...(reply.action ? { action: reply.action } : {}),
    };

    setMessages([...messages, outgoing, answer]);
  }

  /** What the customer sees when they tap, rather than the raw option id. */
  function labelFor(id: string, fallback: string): string {
    const menu = welcome().action;
    if (menu?.kind === "buttons") {
      const hit = menu.buttons.find((b) => b.id === id);
      if (hit) return hit.title;
    }
    const label = categoryLabel(id);
    return label === "Salon furniture" ? fallback || id : label;
  }

  function onEnquirySubmitted({ reference, product }: { reference: string; product: FullProduct }) {
    setEnquiry(null);
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: "assistant",
        kind: "receipt",
        content: `The quote request for the ${product.name} is in, reference ${reference}. The team will be in touch by email.`,
        reference,
        productId: product.id,
      },
    ]);
  }

  function reset() {
    setMessages([]);
    setInput("");
    setPendingPhoto(null);
    setPlanIds([]);
    setPlanQty({});
    roomPhotoRef.current = null;
    setHasRoomPhoto(false);
    setChatError(null);
    setThinking(false);
    setFlow(INITIAL);
    setPlanCollapsed(false);
    setPendingZoneRender(false);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(PLAN_KEY);
    } catch {
      /* nothing to clear */
    }
  }

  const empty = messages.length === 0 && !thinking;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[820px] items-center gap-3 px-4 py-3 sm:px-6">
          <BrandMark className="h-8 w-8 text-lg" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight tracking-tight text-ink-1">
              Comfortel
            </p>
            <p className="truncate text-xs text-ink-3">Salon, barber &amp; spa furniture</p>
          </div>
          {WHATSAPP_MODE_ENABLED ? (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-ink-3">
              <span className="hidden sm:inline">WhatsApp Mode</span>
              <span className="sm:hidden">WhatsApp</span>
              <Switch
                checked={whatsapp}
                onCheckedChange={toggleWhatsapp}
                aria-label="WhatsApp Mode"
                className="data-[state=checked]:bg-[#25d366]"
              />
            </label>
          ) : null}
          {!empty ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={reset}
              className="h-8 gap-1.5 px-2.5 text-xs text-ink-3 hover:bg-muted hover:text-ink-1"
            >
              <SquarePen className="h-3.5 w-3.5" />
              New chat
            </Button>
          ) : null}
        </div>
      </header>

      <main
        className={cn(
          "w-full flex-1 px-4 sm:px-6",
          waMode ? "min-h-0 py-4" : "mx-auto max-w-[820px]",
        )}
      >
        {waMode ? (
          // Fills the viewport rather than sitting in the 820px reading column:
          // a phone conversation is tall, and the transcript is the whole point.
          <div className="mx-auto flex h-[calc(100dvh-8.5rem)] min-h-[420px] w-full max-w-[1040px] flex-col">
            <WhatsAppView
              items={toWaItems(messages)}
              value={input}
              onChange={setInput}
              onSend={() => sendWhatsApp(input)}
              onTap={(id) => sendWhatsApp("", id)}
              onPickPhoto={() => waFileRef.current?.click()}
              disabled={thinking}
            />
            <input
              ref={waFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void pickPhoto(e.target.files?.[0])}
            />
            <p className="mx-auto mt-2.5 max-w-[820px] shrink-0 text-center text-[11px] leading-snug text-ink-4">
              A preview of this assistant on WhatsApp, held to the real platform limits — three
              reply buttons, ten list rows, thirty catalogue products. Dashed notes mark what
              WhatsApp would cut.
            </p>
          </div>
        ) : empty ? (
          <EmptyState onPick={send} onPickPhoto={pickPhoto} onOpenWizard={() => setWizard(true)} />
        ) : (
          <div className="space-y-6 py-8" role="log" aria-live="polite" aria-label="Conversation">
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                onOpenProduct={setSheetProduct}
                planIds={planIds}
                onTogglePlan={togglePlan}
                onShareRenders={shareRenders}
                onAcceptOffer={acceptOffer}
                onVisualize={(product) => setPhotoProducts([product])}
                onEnquire={(product, visualizationUrl) => setEnquiry({ product, visualizationUrl })}
                onRetryRender={(entry) => {
                  // Without the original photo — after a page reload — the only
                  // honest retry is to ask for a new one.
                  if (!entry.job.base64) {
                    const product = getProduct(entry.job.productIds[0] ?? "");
                    if (product) setPhotoProducts([product]);
                    return;
                  }
                  void runRender(entry);
                }}
              />
            ))}

            {thinking ? (
              <div className="flex gap-3">
                <BrandMark className="mt-0.5 h-6 w-6" />
                <TypingDots />
              </div>
            ) : null}

            {chatError ? (
              <div className="flex gap-3">
                <BrandMark className="mt-0.5 h-6 w-6" />
                <div className="space-y-2">
                  <p className="text-sm text-ink-2">{chatErrorMessage(chatError)}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border bg-transparent text-ink-1 shadow-none hover:bg-muted"
                    onClick={() => {
                      const last = lastHistoryRef.current;
                      if (last) void runChat(last.history, last.photoAttached);
                    }}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              </div>
            ) : null}

            <div ref={endRef} />
          </div>
        )}
      </main>

      <div
        className={cn(
          "sticky bottom-0 z-20 bg-gradient-to-t from-background via-background to-transparent pb-4 pt-3",
          whatsapp && "hidden",
        )}
      >
        <div className="mx-auto w-full max-w-[820px] space-y-2.5 px-4 sm:px-6">
          <PlanTray
            products={planProducts}
            onRemove={togglePlan}
            onClear={() => {
              setPlanIds([]);
              setPlanQty({});
            }}
            onVisualize={renderPlan}
            hasPhoto={hasRoomPhoto}
            onUseAnotherPhoto={() => setPhotoProducts(planProducts)}
            zoneCount={groupByZone(planProducts).length}
            onRenderByZone={isSplittable(planProducts) ? renderPlanByZone : undefined}
            quantities={planQty}
            collapsed={planCollapsed}
            onExpand={() => setPlanCollapsed(false)}
          />
          <ChatComposer
            value={input}
            onChange={setInput}
            onSend={() => send(input)}
            disabled={thinking}
            photo={pendingPhoto?.preview ?? null}
            photoLoading={photoLoading}
            onPickPhoto={pickPhoto}
            onClearPhoto={() => setPendingPhoto(null)}
          />
          <p className="mt-2 text-center text-[11px] text-ink-4">
            Renders are AI approximations — check dimensions before you order.
          </p>
        </div>
      </div>

      <PlanWizard open={wizard} onClose={() => setWizard(false)} onChoose={acceptPackage} />

      <ProductSheet
        product={sheetProduct}
        open={sheetProduct !== null}
        onClose={() => setSheetProduct(null)}
        onVisualize={(product) => {
          setSheetProduct(null);
          setPhotoProducts([product]);
        }}
        onEnquire={(product) => {
          setSheetProduct(null);
          setEnquiry({ product });
        }}
      />

      <VisualizePhotoDialog
        products={photoProducts}
        open={photoProducts.length > 0}
        onClose={() => setPhotoProducts([])}
        onSubmit={acceptPhoto}
      />

      <EnquiryDialog
        target={enquiry}
        open={enquiry !== null}
        onClose={() => setEnquiry(null)}
        onSubmitted={onEnquirySubmitted}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------

function MessageRow({
  message,
  onOpenProduct,
  onVisualize,
  onEnquire,
  onRetryRender,
  planIds,
  onTogglePlan,
  onShareRenders,
  onAcceptOffer,
}: {
  message: Message;
  onOpenProduct: (product: FullProduct) => void;
  onVisualize: (product: FullProduct) => void;
  planIds: string[];
  onTogglePlan: (product: FullProduct) => void;
  onShareRenders: (entries: RenderEntry[]) => void | Promise<void>;
  onEnquire: (product: FullProduct, visualizationUrl?: string) => void;
  onRetryRender: (entry: RenderEntry) => void;
  onAcceptOffer: (offer: RenderRequest) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-2">
          {message.kind === "photo" && message.photo ? (
            <img
              src={message.photo}
              alt="The space you uploaded"
              className="ml-auto max-h-56 rounded-2xl border border-border object-cover"
            />
          ) : null}
          <p className="ml-auto w-fit rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-relaxed text-ink-1">
            {message.kind === "text" && message.display ? message.display : message.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <BrandMark className="mt-0.5 h-6 w-6" />
      <div className="min-w-0 flex-1 space-y-3">
        {message.kind === "receipt" ? (
          <div className="flex max-w-[440px] items-start gap-2.5 rounded-2xl border border-border bg-primary-soft px-3.5 py-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ink-1" />
            <p className="text-sm leading-relaxed text-ink-1">{message.content}</p>
          </div>
        ) : (
          <>
            {message.content && message.kind !== "visualization" ? (
              <Markdown text={message.content} />
            ) : null}

            {message.kind === "text" && message.productIds?.length ? (
              <ProductStrip>
                {message.productIds.map((id) => {
                  const product = getProduct(id);
                  if (!product) return null;
                  return (
                    <ProductCard
                      key={id}
                      product={product}
                      onOpen={onOpenProduct}
                      onVisualize={onVisualize}
                      onEnquire={(p) => onEnquire(p)}
                      inPlan={planIds.includes(id)}
                      planFull={planIds.length >= MAX_REFERENCES}
                      onTogglePlan={onTogglePlan}
                    />
                  );
                })}
              </ProductStrip>
            ) : null}

            {/*
              The model wanted to render on a turn that did not ask for one.
              Offering it costs nothing and declining it is simply not tapping —
              which is the whole point: half of an ordinary conversation about a
              picture used to bill for a new one.
            */}
            {message.kind === "text" && message.offer ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => onAcceptOffer(message.offer as RenderRequest)}
              >
                <Sparkles className="h-3.5 w-3.5" />
                See this in your space
              </Button>
            ) : null}

            {message.kind === "visualization" ? (
              <VisualizationMessage
                states={message.entries.map((e) => e.vis)}
                onRetry={(index) => {
                  const entry = message.entries[index];
                  if (entry) onRetryRender(entry);
                }}
                onShare={() => void onShareRenders(message.entries)}
                onEnquire={(index, imageUrl) => {
                  // A refit lists several products; the quote hangs off the lead one.
                  const id = message.entries[index]?.vis.productIds[0];
                  const product = id ? getProduct(id) : undefined;
                  if (product) onEnquire(product, imageUrl);
                }}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A deployed host missing its API key and a transient network fault both used to
 * read "Something went wrong", which is useless to whoever has to fix it. These
 * name the class of fault without exposing anything sensitive.
 */
function chatErrorMessage(code: string): string {
  switch (code) {
    case "CHAT_NOT_CONFIGURED":
      return "The assistant isn't switched on for this site yet — ANTHROPIC_API_KEY is missing on the server.";
    case "CHAT_KEY_REJECTED":
      return "The assistant's API key was rejected. It may be expired or out of credit.";
    case "CHAT_RATE_LIMITED":
      return "We're being rate-limited right now. Give it a few seconds and try again.";
    case "CHAT_UPSTREAM_ERROR":
      return "The assistant is having trouble responding. Try that again?";
    default:
      return "Something went wrong — try that again?";
  }
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-2" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-4"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
