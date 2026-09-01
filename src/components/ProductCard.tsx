import { Check, ImageIcon, Plus, Sparkles } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  categoryLabel,
  discountPercent,
  formatPrice,
  isVisualizable,
  type FullProduct,
} from "@/lib/catalog";

export function ProductCard({
  product,
  onOpen,
  onVisualize,
  onEnquire,
  inPlan = false,
  planFull = false,
  onTogglePlan,
}: {
  product: FullProduct;
  onOpen: (product: FullProduct) => void;
  onVisualize: (product: FullProduct) => void;
  onEnquire: (product: FullProduct) => void;
  inPlan?: boolean;
  planFull?: boolean;
  onTogglePlan?: (product: FullProduct) => void;
}) {
  const [broken, setBroken] = useState(false);
  const canVisualize = isVisualizable(product.id);
  const off = discountPercent(product);
  const image = product.images?.[0];

  return (
    <article className="relative flex w-[228px] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-border bg-surface2 transition-shadow hover:shadow-[0_1px_2px_rgba(15,15,12,0.04),0_8px_24px_-12px_rgba(15,15,12,0.18)]">
      {canVisualize && onTogglePlan ? (
        <button
          type="button"
          onClick={() => onTogglePlan(product)}
          disabled={!inPlan && planFull}
          aria-pressed={inPlan}
          aria-label={
            inPlan ? `Remove ${product.name} from your plan` : `Add ${product.name} to your plan`
          }
          title={
            !inPlan && planFull ? "Your plan is full" : inPlan ? "In your plan" : "Add to your plan"
          }
          className={cn(
            "absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors",
            inPlan
              ? "border-ink-1 bg-ink-1 text-primary"
              : "border-border bg-surface2/90 text-ink-3 hover:border-border-strong hover:text-ink-1",
            !inPlan &&
              planFull &&
              "cursor-not-allowed opacity-40 hover:border-border hover:text-ink-3",
          )}
        >
          {inPlan ? (
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
        </button>
      ) : null}

      <button
        type="button"
        onClick={() => onOpen(product)}
        className="group block w-full text-left"
        aria-label={`View details for ${product.name}`}
      >
        {/* Comfortel shoots on white and crops square. object-contain rather
            than cover, or a 1:1 cut-out in a 4:3 frame loses the top of the
            basin and the feet of every chair. */}
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted p-2">
          {image && !broken ? (
            <img
              src={image}
              alt={product.name}
              loading="lazy"
              onError={() => setBroken(true)}
              className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.04]"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-ink-4">
              <ImageIcon className="h-6 w-6" />
            </div>
          )}

          {off !== null ? (
            <span className="absolute left-2 top-2 rounded-full bg-ink-1 px-2 py-0.5 text-[11px] font-medium text-primary">
              {off}% off
            </span>
          ) : null}
        </div>

        <div className="space-y-1.5 px-3 pb-1 pt-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
            {categoryLabel(product.category)}
          </p>
          <p className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-snug text-ink-1">
            {product.name}
          </p>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-ink-1">{formatPrice(product.price)}</span>
            {off !== null ? (
              <span className="text-xs text-ink-4 line-through">{formatPrice(product.mrp)}</span>
            ) : null}
          </div>
        </div>
      </button>

      <div className="mt-auto flex flex-col gap-1.5 p-3 pt-2">
        {canVisualize ? (
          <Button
            size="sm"
            onClick={() => onVisualize(product)}
            className="h-8 w-full bg-primary text-xs font-medium text-primary-foreground shadow-none hover:bg-primary-strong"
          >
            <Sparkles className="h-3.5 w-3.5" />
            See it in my space
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onEnquire(product)}
          className="h-8 w-full border-border bg-transparent text-xs font-medium text-ink-2 shadow-none hover:bg-muted hover:text-ink-1"
        >
          Request a quote
        </Button>
      </div>
    </article>
  );
}
