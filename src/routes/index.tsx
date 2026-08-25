import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, RefreshCw, SquarePen } from "lucide-react";
import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState } from "react";

import { BrandMark } from "@/components/BrandMark";
import { ChatComposer } from "@/components/ChatComposer";
import { EnquiryDialog, type EnquiryTarget } from "@/components/EnquiryDialog";
import { Markdown } from "@/components/Markdown";
import { ProductCard } from "@/components/ProductCard";
import { ProductSheet } from "@/components/ProductSheet";
import { PlanTray } from "@/components/PlanTray";
import { ProductStrip } from "@/components/ProductStrip";
import { VisualizationMessage, type VisualizationState } from "@/components/VisualizationMessage";
import { VisualizePhotoDialog, type VisualizeRequest } from "@/components/VisualizePhotoDialog";
import { MAX_REFERENCES } from "@/lib/visualize-prompt";
import { groupByZone, isSplittable } from "@/lib/zones";
import { Button } from "@/components/ui/button";
import { getProduct, type FullProduct } from "@/lib/catalog";
import { chat, type ChatMessageInput } from "@/lib/chat.functions";
import { shareDesign } from "@/lib/design.functions";
import { resizeImage, type ResizedImage } from "@/lib/resize-image";
import { visualizeStart, visualizeStatus } from "@/lib/visualize.functions";
import { isMultiReferenceMode, type VisualizeMode } from "@/lib/visualize-prompt";

const TITLE = "Comfortel — Salon Furniture Assistant";
const DESCRIPTION =
  "Chat with a Comfortel specialist to find salon, barber and spa furniture, see any piece rendered into a photo of your own space, and request a quote.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
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
};

/** One render inside a visualization message. A comparison set holds several. */
type RenderEntry = { id: string; vis: VisualizationState; job: VisualizeJob };

type Message =
  | { id: string; role: "user"; kind: "text"; content: string }
  | {
      id: string;
      role: "user";
      kind: "photo";
      content: string;
      photo: string;
      productId: string;
    }
  | { id: string; role: "assistant"; kind: "text"; content: string; productIds?: string[] }
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

const SEED_PROMPTS = [
  "I'm fitting out a four-chair salon from scratch",
  "Black styling chairs under $500",
  "Backwash units with an electric recline",
  "A reception desk and waiting seating that go together",
];

const POLL_INTERVAL_MS = 3000;

/**
 * 100 x 3s = 5 minutes. GPT Image 2 renders measured at 80-98s, against the old
 * 40-poll (120s) ceiling — close enough that a slow render would have shown the
 * customer a timeout for an image kie had generated and charged us for. The
 * window costs nothing when renders are fast; it only has to outlast the worst.
 */
const MAX_POLLS = 100;
const STORAGE_KEY = "comfortel.chat.v1";
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

let seq = 0;
const nextId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The customer's salon photo, held for the session so later turns can reuse it. */
type RoomPhoto = { image: ResizedImage; preview: string };

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
): { message: Message; entries: RenderEntry[] } {
  const entries: RenderEntry[] = groups.map((group) => ({
    id: nextId(),
    job: {
      productIds: group.products.map((p) => p.id),
      base64: photo.image.base64,
      mode: "refit_room" as VisualizeMode,
      aspectRatio: photo.image.aspectRatio,
      scene: group.scene,
    },
    vis: {
      productIds: group.products.map((p) => p.id),
      label: group.label,
      before: photo.preview,
      status: "loading",
    },
  }));

  return {
    message: { id: nextId(), role: "assistant", kind: "visualization", content: "", entries },
    entries,
  };
}

function buildRenderMessage(
  mode: VisualizeMode,
  productIds: string[],
  photo: RoomPhoto,
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

  const entries: RenderEntry[] = groups.map((ids) => ({
    id: nextId(),
    job: { ...base, productIds: ids },
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
  }));

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

  const planProducts = planIds
    .map((id) => getProduct(id))
    .filter((p): p is FullProduct => Boolean(p));

  const togglePlan = useCallback((product: FullProduct) => {
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
  }, []);

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
  const runRender = useCallback(
    async (entry: RenderEntry) => {
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
          },
        });

        if (started.imageUrl) {
          patchRender(id, { status: "done", imageUrl: started.imageUrl });
          return;
        }
        if (!started.taskId) throw new Error("no task id");

        for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const res = await pollVisualize({ data: { taskId: started.taskId } });
          if (res.done && res.imageUrl) {
            patchRender(id, { status: "done", imageUrl: res.imageUrl });
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
    [patchRender, pollVisualize, startVisualize],
  );

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

        const res = await sendChat({
          data: { messages: payload, hasRoomPhoto: photoAttached },
        });

        const next: Message[] = [
          ...history,
          {
            id: nextId(),
            role: "assistant",
            kind: "text",
            content: res.text,
            productIds: res.productIds,
          },
        ];

        // The assistant can ask for renders itself. It only ever gets here when
        // a photo is attached — the server refuses to parse the marker otherwise.
        const photo = roomPhotoRef.current;
        if (res.render && photo) {
          const { message, entries } = buildRenderMessage(
            res.render.mode,
            res.render.productIds,
            photo,
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

  function send(text: string) {
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
        : { id: nextId(), role: "user", kind: "text", content },
    ];
    setMessages(next);
    setInput("");
    setPendingPhoto(null);
    void runChat(next, roomPhotoRef.current !== null);
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
  function startRender(products: FullProduct[], mode: VisualizeMode, photo: RoomPhoto) {
    const verb =
      mode === "add" ? "into" : mode === "replace_all" ? "throughout" : "in place of what's in";

    const ids = products.map((p) => p.id);
    const { message, entries } = buildRenderMessage(mode, ids, photo);

    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: "user",
        kind: "photo",
        content:
          products.length > 1
            ? `Fit my space out with these ${products.length} pieces.`
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
  function renderPlanByZone() {
    if (!planProducts.length) return;
    const photo = roomPhotoRef.current;
    if (!photo) {
      setPhotoProducts(planProducts);
      return;
    }

    const groups = groupByZone(planProducts);
    const { message, entries } = buildZoneRenderMessage(groups, photo);

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
    startRender(planProducts, planProducts.length > 1 ? "refit_room" : "replace_all", photo);
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
    roomPhotoRef.current = null;
    setHasRoomPhoto(false);
    setChatError(null);
    setThinking(false);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
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

      <main className="mx-auto w-full max-w-[820px] flex-1 px-4 sm:px-6">
        {empty ? (
          <EmptyState onPick={send} />
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

      <div className="sticky bottom-0 z-20 bg-gradient-to-t from-background via-background to-transparent pb-4 pt-3">
        <div className="mx-auto w-full max-w-[820px] space-y-2.5 px-4 sm:px-6">
          <PlanTray
            products={planProducts}
            onRemove={togglePlan}
            onClear={() => setPlanIds([])}
            onVisualize={renderPlan}
            hasPhoto={hasRoomPhoto}
            onUseAnotherPhoto={() => setPhotoProducts(planProducts)}
            zoneCount={groupByZone(planProducts).length}
            onRenderByZone={isSplittable(planProducts) ? renderPlanByZone : undefined}
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
}: {
  message: Message;
  onOpenProduct: (product: FullProduct) => void;
  onVisualize: (product: FullProduct) => void;
  planIds: string[];
  onTogglePlan: (product: FullProduct) => void;
  onShareRenders: (entries: RenderEntry[]) => void | Promise<void>;
  onEnquire: (product: FullProduct, visualizationUrl?: string) => void;
  onRetryRender: (entry: RenderEntry) => void;
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
            {message.content}
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

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex min-h-[58vh] flex-col justify-center py-10">
      <div className="max-w-[560px]">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink-1 sm:text-3xl">
          What are you fitting out?
        </h1>
        <p className="mt-2.5 text-sm leading-relaxed text-ink-3">
          Tell us about the space — the area, how many stations, the look you&apos;re after. We will
          pull the right pieces from the Comfortel range, and you can see any of them rendered into
          a photo of your own salon.
        </p>
      </div>

      <div className="mt-7 flex flex-wrap gap-2">
        {SEED_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            className="rounded-full border border-border bg-surface2 px-3.5 py-2 text-sm text-ink-2 transition-colors hover:border-border-strong hover:bg-muted hover:text-ink-1"
          >
            {prompt}
          </button>
        ))}
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
