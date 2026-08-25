import { ExternalLink, ImageIcon, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  categoryLabel,
  dimsLabel,
  discountPercent,
  displaySpecs,
  formatPrice,
  isVisualizable,
  productDescription,
  type FullProduct,
} from "@/lib/catalog";
import { cn } from "@/lib/utils";

export function ProductSheet({
  product,
  open,
  onClose,
  onVisualize,
  onEnquire,
}: {
  product: FullProduct | null;
  open: boolean;
  onClose: () => void;
  onVisualize: (product: FullProduct) => void;
  onEnquire: (product: FullProduct) => void;
}) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
  }, [product?.id]);

  if (!product) return null;

  const images = product.images ?? [];
  const off = discountPercent(product);
  const dims = dimsLabel(product);
  const specs = displaySpecs(product);
  const canVisualize = isVisualizable(product.id);
  const description = productDescription(product);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto border-border bg-surface2 p-0 sm:max-w-[860px]">
        <DialogTitle className="sr-only">{product.name}</DialogTitle>

        <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_360px]">
          {/* Gallery */}
          <div className="bg-muted p-4 sm:p-6">
            <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-surface2">
              {images[active] ? (
                <img
                  src={images[active]}
                  alt={`${product.name} — view ${active + 1}`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-ink-4">
                  <ImageIcon className="h-8 w-8" />
                </div>
              )}
            </div>

            {images.length > 1 ? (
              <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
                {images.slice(0, 12).map((src, i) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setActive(i)}
                    aria-label={`View image ${i + 1}`}
                    aria-current={i === active}
                    className={cn(
                      "h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 bg-surface2 transition-colors",
                      i === active
                        ? "border-ink-1"
                        : "border-transparent hover:border-border-strong",
                    )}
                  >
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Detail */}
          <div className="flex flex-col gap-4 p-5 sm:p-6">
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
                {categoryLabel(product.category)}
              </p>
              <h2 className="pr-8 text-lg font-semibold leading-tight text-ink-1">
                {product.name}
              </h2>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-xl font-semibold text-ink-1">
                  {formatPrice(product.price)}
                </span>
                {off !== null ? (
                  <>
                    <span className="text-sm text-ink-4 line-through">
                      {formatPrice(product.mrp)}
                    </span>
                    <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-ink-1">
                      Save {off}%
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            <dl className="space-y-1.5 text-sm">
              {dims ? <Row label="Dimensions" value={dims} /> : null}
              {product.sku ? <Row label="SKU" value={product.sku} /> : null}
              {product.delivery_date ? (
                <Row label="Available" value={product.delivery_date} />
              ) : null}
              <Row label="Stock" value={product.in_stock ? "In stock" : "Made to order"} />
            </dl>

            {description ? (
              <p className="text-sm leading-relaxed text-ink-2">{description}</p>
            ) : null}

            {specs.length ? (
              <div className="rounded-xl border border-border">
                <p className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">
                  Specifications
                </p>
                <dl className="divide-y divide-border">
                  {specs.map(([k, v]) => (
                    <div key={k} className="flex gap-3 px-3 py-2 text-sm">
                      <dt className="w-[42%] shrink-0 text-ink-3">{k}</dt>
                      <dd className="text-ink-1">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}

            <div className="mt-auto flex flex-col gap-2 pt-2">
              {canVisualize ? (
                <Button
                  onClick={() => onVisualize(product)}
                  className="bg-primary text-primary-foreground shadow-none hover:bg-primary-strong"
                >
                  <Sparkles className="h-4 w-4" />
                  See it in my space
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={() => onEnquire(product)}
                className="border-border bg-transparent text-ink-1 shadow-none hover:bg-muted"
              >
                Request a quote
              </Button>
              {product.url ? (
                <a
                  href={product.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 py-1 text-xs text-ink-3 underline-offset-4 hover:text-ink-1 hover:underline"
                >
                  View on comfortelfurniture.com
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[42%] shrink-0 text-ink-3">{label}</dt>
      <dd className="text-ink-1">{value}</dd>
    </div>
  );
}
