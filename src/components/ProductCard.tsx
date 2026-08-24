import { formatPrice, isVisualizable, type FullProduct } from "@/lib/catalog";
import { Button } from "@/components/ui/button";

export function ProductCard({
  product,
  onVisualize,
}: {
  product: FullProduct;
  onVisualize: (product: FullProduct) => void;
}) {
  const canVisualize = isVisualizable(product.id);
  const showMrp = product.mrp != null && product.price != null && product.mrp > product.price;

  return (
    <div className="w-[200px] shrink-0 overflow-hidden rounded-xl border border-border bg-surface2">
      <button
        type="button"
        onClick={() => window.open(product.url, "_blank", "noopener,noreferrer")}
        className="block w-full text-left"
      >
        <div className="aspect-[4/3] w-full overflow-hidden bg-muted">
          {product.images?.[0] ? (
            <img
              src={product.images[0]}
              alt={product.name}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : null}
        </div>
        <div className="p-3">
          <p
            className="text-sm font-medium leading-snug text-ink-1"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {product.name}
          </p>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-sm font-semibold text-ink-1">{formatPrice(product.price)}</span>
            {showMrp ? (
              <span className="text-xs text-ink-4 line-through">{formatPrice(product.mrp)}</span>
            ) : null}
          </div>
        </div>
      </button>

      {canVisualize ? (
        <div className="px-3 pb-3">
          <Button
            variant="secondary"
            size="sm"
            className="w-full border border-border bg-primary-soft text-xs font-medium text-ink-1 hover:bg-primary-muted"
            onClick={() => onVisualize(product)}
          >
            See it in my room
          </Button>
        </div>
      ) : null}
    </div>
  );
}
