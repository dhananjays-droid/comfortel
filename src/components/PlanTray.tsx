import { ImageIcon, Sparkles, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatPrice, type FullProduct } from "@/lib/catalog";
import { MAX_REFERENCES, RECOMMENDED_REFERENCES } from "@/lib/visualize-prompt";
import { cn } from "@/lib/utils";

/**
 * The plan: products the customer wants to see together in one render.
 *
 * Sits above the composer rather than in a separate screen, because the whole
 * point is that it fills up while they keep chatting. It doubles as the running
 * quote — the subtotal is the cheapest useful thing we can show, since every
 * product already carries a price.
 */
export function PlanTray({
  products,
  onRemove,
  onClear,
  onVisualize,
  hasPhoto = false,
  onUseAnotherPhoto,
}: {
  products: FullProduct[];
  onRemove: (product: FullProduct) => void;
  onClear: () => void;
  onVisualize: () => void;
  /** True once a room photo is in the session, so rendering needs no upload. */
  hasPhoto?: boolean;
  onUseAnotherPhoto?: () => void;
}) {
  if (!products.length) return null;

  const subtotal = products.reduce((sum, p) => sum + (p.price ?? 0), 0);
  const crowded = products.length > RECOMMENDED_REFERENCES;

  return (
    <div className="rounded-2xl border border-border bg-surface2 p-3 shadow-[0_-2px_16px_-8px_rgba(15,15,12,0.15)]">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Your plan
          <span className="ml-1.5 normal-case tracking-normal text-ink-4">
            {products.length} of {MAX_REFERENCES}
          </span>
        </p>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-ink-4 underline-offset-2 transition-colors hover:text-ink-2 hover:underline"
        >
          Clear
        </button>
      </div>

      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {products.map((product) => (
          <div
            key={product.id}
            className="group relative flex w-[92px] shrink-0 flex-col gap-1"
            title={product.name}
          >
            <div className="relative aspect-square overflow-hidden rounded-xl border border-border bg-muted p-1">
              {product.images?.[0] ? (
                <img
                  src={product.images[0]}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-ink-4">
                  <ImageIcon className="h-4 w-4" />
                </div>
              )}
              <button
                type="button"
                onClick={() => onRemove(product)}
                aria-label={`Remove ${product.name} from your plan`}
                className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink-1/85 text-surface2 opacity-0 transition-opacity hover:bg-ink-1 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <p className="line-clamp-2 text-[11px] leading-tight text-ink-3">{product.name}</p>
          </div>
        ))}
      </div>

      {crowded ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-muted px-2.5 py-2 text-[11px] leading-snug text-ink-3">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Past {RECOMMENDED_REFERENCES} pieces in one image, each one gets less detail. Still
            worth seeing — just expect the individual products to read less sharply.
          </span>
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-ink-3">
            Subtotal <span className="font-semibold text-ink-1">{formatPrice(subtotal)}</span>
          </p>
          {hasPhoto && onUseAnotherPhoto ? (
            <button
              type="button"
              onClick={onUseAnotherPhoto}
              className="text-[11px] text-ink-4 underline-offset-2 transition-colors hover:text-ink-2 hover:underline"
            >
              Use another photo
            </button>
          ) : null}
        </div>
        <Button
          size="sm"
          onClick={onVisualize}
          className={cn(
            "h-8 gap-1.5 bg-primary text-xs font-medium text-primary-foreground shadow-none",
            "hover:bg-primary-strong",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {hasPhoto
            ? `Render ${products.length === 1 ? "it" : "these"}`
            : `See ${products.length === 1 ? "it" : "these"} in my space`}
        </Button>
      </div>
    </div>
  );
}
