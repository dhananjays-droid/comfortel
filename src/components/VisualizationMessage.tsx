import { Download, Expand, RefreshCw, Share2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { ProductStrip } from "@/components/ProductStrip";
import { VisualizationLightbox } from "@/components/VisualizationLightbox";
import { Button } from "@/components/ui/button";
import { downloadImage } from "@/lib/download-image";
import { cn } from "@/lib/utils";

export type VisualizationState = {
  /** One id for the placement modes; several for a whole-room refit. */
  productIds: string[];
  /** Caption shown when several renders sit side by side. */
  label: string;
  /** data: URL of the customer's original photo, for the before/after compare */
  before: string;
  status: "loading" | "done" | "error";
  imageUrl?: string | undefined;
  progress?: number | undefined;
  error?: string | undefined;
};

const STATUS_MESSAGES = [
  "Reading your space...",
  "Removing what's there...",
  "Matching the lighting...",
  "Checking the mirrors...",
  "Almost there...",
];

/**
 * One render, or a comparison set. A single render gets the full column width
 * because the customer is judging one placement; several go in a scroll rail so
 * they can be compared against each other, which is the whole point of asking
 * for five chairs at once.
 */
export function VisualizationMessage({
  states,
  onRetry,
  onEnquire,
  onShare,
}: {
  states: VisualizationState[];
  onRetry: (index: number) => void;
  onEnquire: (index: number, imageUrl: string) => void;
  /** Shares the whole message — every render in it, not just one. */
  onShare?: (() => void) | undefined;
}) {
  if (states.length === 1) {
    return (
      <RenderCard
        state={states[0]!}
        onRetry={() => onRetry(0)}
        onEnquire={(url) => onEnquire(0, url)}
        onShare={onShare}
      />
    );
  }

  return (
    <div className="space-y-2">
      <ProductStrip>
        {states.map((state, i) => (
          <div key={i} className="w-[252px] shrink-0 snap-start">
            <RenderCard
              compact
              state={state}
              onRetry={() => onRetry(i)}
              onEnquire={(url) => onEnquire(i, url)}
            />
          </div>
        ))}
      </ProductStrip>
      <p className="text-xs text-ink-3">
        {states.filter((s) => s.status === "done").length} of {states.length} ready — tap any image
        to see it full screen.
      </p>
    </div>
  );
}

function RenderCard({
  state,
  compact = false,
  onRetry,
  onEnquire,
  onShare,
}: {
  state: VisualizationState;
  compact?: boolean;
  onRetry: () => void;
  onEnquire: (imageUrl: string) => void;
  onShare?: (() => void) | undefined;
}) {
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<"after" | "before">("after");
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (state.status !== "loading") return;
    setTick(0);
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, [state.status]);

  const frame = compact ? "w-full" : "max-w-[440px]";

  if (state.status === "loading") {
    const message = STATUS_MESSAGES[Math.min(tick, STATUS_MESSAGES.length - 1)];
    const progress = Math.max(4, Math.round((state.progress ?? 0) * 100));
    return (
      <div className={cn("overflow-hidden rounded-2xl border border-border bg-surface2", frame)}>
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
          {state.before ? (
            <img
              src={state.before}
              alt=""
              className="h-full w-full scale-105 object-cover opacity-40 blur-[2px]"
            />
          ) : null}
          <div className="shimmer absolute inset-0" />
        </div>
        <div className="space-y-2 p-3">
          {compact ? (
            <p className="truncate text-xs font-medium text-ink-1">{state.label}</p>
          ) : null}
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary-strong transition-[width] duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-ink-3">
            {compact ? "Rendering" : message}{" "}
            <span className="tabular-nums text-ink-4">{progress}%</span>
          </p>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className={cn("space-y-3 rounded-2xl border border-border bg-surface2 p-4", frame)}>
        {compact ? <p className="truncate text-xs font-medium text-ink-1">{state.label}</p> : null}
        <p className="text-sm text-ink-2">
          {state.error ?? "We couldn't place that piece in your space just now."}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={onRetry}
          className="border-border bg-transparent text-ink-1 shadow-none hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      </div>
    );
  }

  // After a page reload the original photo is gone (it is never persisted),
  // so the compare toggle is hidden rather than shown pointing at nothing.
  const canCompare = state.before.length > 0;
  const src = canCompare && view === "before" ? state.before : state.imageUrl!;

  return (
    <div className={cn("space-y-2", frame)}>
      <div className="relative overflow-hidden rounded-2xl border border-border bg-muted">
        <button
          type="button"
          onClick={() => setZoomed(true)}
          className="group block w-full cursor-zoom-in"
          aria-label={`View ${state.label} full screen`}
        >
          <img
            src={src}
            alt={
              view === "after" ? `${state.label} rendered into your space` : "Your original photo"
            }
            className={cn("w-full object-cover", compact && "aspect-[4/3]")}
          />
          <span className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-ink-1/70 text-surface2 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Expand className="h-3.5 w-3.5" />
          </span>
        </button>
        {canCompare && !compact ? (
          <div className="absolute bottom-2 left-2 flex overflow-hidden rounded-full border border-border bg-surface2/95 p-0.5 backdrop-blur-sm">
            {(["after", "before"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setView(option)}
                aria-pressed={view === option}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                  view === option ? "bg-ink-1 text-primary" : "text-ink-3 hover:text-ink-1",
                )}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {compact ? (
        <>
          <p className="truncate text-xs font-medium text-ink-1">{state.label}</p>
          <div className="flex gap-1">
            <Button
              size="sm"
              onClick={() => onEnquire(state.imageUrl!)}
              className="h-7 flex-1 bg-primary text-xs text-primary-foreground shadow-none hover:bg-primary-strong"
            >
              Quote
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label="Download"
              onClick={() => void downloadImage(state.imageUrl!, state.label)}
              className="h-7 w-8 border-border bg-transparent p-0 text-ink-2 shadow-none hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => onEnquire(state.imageUrl!)}
            className="bg-primary text-xs text-primary-foreground shadow-none hover:bg-primary-strong"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Request a quote
          </Button>
          {onShare ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onShare}
              className="border-border bg-transparent text-xs text-ink-2 shadow-none hover:bg-muted hover:text-ink-1"
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void downloadImage(state.imageUrl!, state.label)}
            className="border-border bg-transparent text-xs text-ink-2 shadow-none hover:bg-muted hover:text-ink-1"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRetry}
            className="text-xs text-ink-3 hover:text-ink-1"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Another photo
          </Button>
        </div>
      )}

      <VisualizationLightbox
        open={zoomed}
        onClose={() => setZoomed(false)}
        after={state.imageUrl!}
        before={state.before}
        productName={state.label}
      />
    </div>
  );
}
