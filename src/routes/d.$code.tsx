import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ImageIcon } from "lucide-react";

import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { formatPrice, getProduct } from "@/lib/catalog";
import { loadDesign, type SharedDesign } from "@/lib/design.functions";

const TITLE = "A Comfortel salon design";

export const Route = createFileRoute("/d/$code")({
  loader: async ({ params }) => {
    try {
      return { design: await loadDesign({ data: { code: params.code } }) };
    } catch {
      // A bad or expired code is an ordinary outcome, not an error page.
      return { design: null };
    }
  },
  head: () => ({
    meta: [
      { title: TITLE },
      {
        name: "description",
        content: "Salon furniture chosen and rendered with the Comfortel assistant.",
      },
      // A shared design shows the inside of someone's salon. It is reachable by
      // anyone holding the link, which is the point, but it should never turn up
      // in a search result.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: SharedDesignPage,
});

function SharedDesignPage() {
  const { design } = Route.useLoaderData();

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <header className="border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[820px] items-center gap-3 px-4 py-3 sm:px-6">
          <BrandMark className="h-8 w-8 text-lg" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight tracking-tight text-ink-1">
              Comfortel
            </p>
            <p className="truncate text-xs text-ink-3">Salon, barber &amp; spa furniture</p>
          </div>
          <Button asChild size="sm" variant="ghost" className="h-8 px-2.5 text-xs text-ink-3">
            <Link to="/">Start your own</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[820px] flex-1 px-4 py-8 sm:px-6">
        {design ? <Design design={design} /> : <Missing />}
      </main>
    </div>
  );
}

function Missing() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold text-ink-1">This design link isn&apos;t available</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-3">
        The link may be mistyped, or whoever shared it may have created a new one.
      </p>
      <Button asChild className="mt-6 bg-primary text-primary-foreground hover:bg-primary-strong">
        <Link to="/">
          Design your own salon
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}

function Design({ design }: { design: SharedDesign }) {
  const products = design.productIds
    .map((id) => getProduct(id))
    .filter((p): p is NonNullable<ReturnType<typeof getProduct>> => Boolean(p));

  // Prefer the snapshotted total: catalogue prices move, and a shared link
  // should keep showing the figure the customer actually saw.
  const subtotal = design.subtotalCents ?? products.reduce((sum, p) => sum + (p.price ?? 0), 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-1">A salon design</h1>
        <p className="mt-1 text-sm text-ink-3">
          {products.length} {products.length === 1 ? "piece" : "pieces"}, rendered into a real space
          with the Comfortel assistant.
        </p>
      </div>

      {design.renders.length ? (
        <section className="space-y-4">
          {design.renders.map((render) => (
            <figure key={render.imageUrl} className="space-y-2">
              <img
                src={render.imageUrl}
                alt={render.label}
                className="w-full rounded-2xl border border-border bg-muted"
              />
              <figcaption className="text-xs text-ink-3">{render.label}</figcaption>
            </figure>
          ))}
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">The pieces</h2>
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface2">
          {products.map((product) => (
            <li key={product.id} className="flex items-center gap-3 p-3">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted p-1">
                {product.images?.[0] ? (
                  <img
                    src={product.images[0]}
                    alt=""
                    className="h-full w-full object-contain"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-ink-4">
                    <ImageIcon className="h-4 w-4" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-1">{product.name}</p>
                <p className="text-xs text-ink-3">{formatPrice(product.price)}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between px-1">
          <span className="text-xs text-ink-3">Subtotal</span>
          <span className="text-sm font-semibold text-ink-1">{formatPrice(subtotal)}</span>
        </div>
      </section>

      <div className="rounded-2xl border border-border bg-primary-soft p-4">
        <p className="text-sm font-medium text-ink-1">Want this for your salon?</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          Upload a photo of your own space and see these pieces rendered into it.
        </p>
        <Button asChild className="mt-3 bg-primary text-primary-foreground hover:bg-primary-strong">
          <Link to="/">
            Start your own design
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      <p className="text-center text-[11px] text-ink-4">
        Renders are AI approximations — check dimensions before you order.
      </p>
    </div>
  );
}
