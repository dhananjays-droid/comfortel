import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  ImageOff,
  Loader2,
  PackageOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ProductCsvDialog } from "@/components/product-csv-dialog";
import { exportProductsCsv } from "@/lib/product-csv-download";
import { emptyProduct } from "@/lib/product-csv";
import {
  managedProductSchema,
  type ManagedProduct,
  type ProductRow,
} from "@/lib/product-management";

type SyncRow = {
  product_id: string;
  state: string;
  last_error: string | null;
  synced_revision: number;
  desired_revision: number;
};
type Data = {
  products: ProductRow[];
  sync: SyncRow[];
  settings: { enabled: boolean; sync_enabled: boolean; catalog_id: string | null };
};

const control =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:border-primary-strong focus:ring-2 focus:ring-primary-strong/20 disabled:opacity-60";

const money = (price: number | null, currency: string) =>
  price === null
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price);

/**
 * One product library for WhatsApp, quotes and the Meta catalog.
 *
 * The list stays on screen while a product is edited in a side sheet — an
 * edit is a detour, not a destination, and staff kept losing their place when
 * the table vanished. Results that need no follow-up (saved, synced, exported)
 * are toasts; anything that needs reading or action stays inline.
 */
export function ProductManager({
  token,
  onEditingChange,
}: {
  token: string;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<ManagedProduct | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [revision, setRevision] = useState(0);
  const [specs, setSpecs] = useState<[string, string][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);

  useEffect(() => {
    onEditingChange?.(draft !== null);
    return () => onEditingChange?.(false);
  }, [draft, onEditingChange]);

  const call = useCallback(
    async (body?: unknown) => {
      const response = await fetch("/api/admin/products", {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Product service unavailable");
      return result;
    },
    [token],
  );
  const reload = useCallback(async () => setData((await call()) as Data), [call]);
  useEffect(() => {
    void reload().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  // A draft in progress should survive an accidental tab close.
  useEffect(() => {
    if (!draft) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);

  const rows = useMemo(
    () =>
      data?.products.filter(
        ({ product: p }) =>
          (showArchived || !p.archived) &&
          `${p.name} ${p.id} ${p.sku ?? ""} ${p.category ?? ""}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ) ?? [],
    [data, query, showArchived],
  );
  const syncFor = (id: string) => data?.sync.find((s) => s.product_id === id);

  const dirty =
    draft !== null && JSON.stringify({ ...draft, specs: Object.fromEntries(specs) }) !== original;

  function edit(row?: ProductRow) {
    const next = row ? structuredClone(row.product) : emptyProduct();
    const nextSpecs = Object.entries(row?.product.specs ?? {});
    setDraft(next);
    setSpecs(nextSpecs);
    setOriginal(JSON.stringify({ ...next, specs: Object.fromEntries(nextSpecs) }));
    setRevision(row?.revision ?? 0);
    setFormError("");
  }
  function requestClose() {
    if (dirty) setConfirmDiscard(true);
    else setDraft(null);
  }

  async function run(work: () => Promise<void>, onError: (m: string) => void = setError) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    const keys = specs.map(([k]) => k.trim());
    if (keys.some((k) => !k) || new Set(keys).size !== keys.length)
      throw new Error("Specification names must be unique and not empty.");
    const parsed = managedProductSchema.safeParse({
      ...draft,
      specs: Object.fromEntries(specs.map(([k, v]) => [k.trim(), v])),
    });
    if (!parsed.success)
      throw new Error(
        parsed.error.issues.map((i) => `${i.path.join(" ")}: ${i.message}`).join(" · "),
      );
    await call({ action: "save", product: parsed.data, revision });
    setDraft(null);
    toast.success(revision ? "Product saved" : "Product added", {
      description: "Meta catalog updates are queued separately.",
    });
    await reload();
  }

  function field(
    key: keyof ManagedProduct,
    label: string,
    opts: { multiline?: boolean; hint?: string } = {},
  ) {
    if (!draft) return null;
    const props = {
      className: control,
      value: String(draft[key] ?? ""),
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft({ ...draft, [key]: e.target.value }),
    };
    return (
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">{label}</span>
        {opts.multiline ? <textarea {...props} rows={4} /> : <input {...props} />}
        {opts.hint && <span className="text-xs text-muted-foreground">{opts.hint}</span>}
      </label>
    );
  }

  const total = data?.products.length ?? 0;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-4 border-b border-border px-6 py-5 sm:px-8">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Products</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One library for WhatsApp, quotes and the Meta catalog.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh products"
            disabled={busy}
            onClick={() => void run(reload)}
          >
            <RefreshCw className={busy ? "animate-spin" : ""} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || total === 0}
            onClick={() => {
              if (!data) return;
              exportProductsCsv(data.products);
              toast.success(`Exported ${total} product${total === 1 ? "" : "s"}`);
            }}
          >
            <Download />
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || busy}
            onClick={() => setCsvOpen(true)}
          >
            <Upload />
            Import CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !data}
            onClick={() =>
              void run(async () => {
                const r = await call({ action: "sync" });
                if (r.configured)
                  toast.success(`Meta accepted ${r.synced} update${r.synced === 1 ? "" : "s"}`, {
                    description:
                      r.failed > 0
                        ? `${r.failed} failed and stay queued. Catalog review may take longer.`
                        : "Catalog review may take a little longer.",
                  });
                else toast.message(r.message);
                await reload();
              })
            }
          >
            Sync now
          </Button>
          <Button size="sm" disabled={busy || !data} onClick={() => edit()}>
            <Plus />
            Add product
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
        {error && (
          <p
            role="alert"
            className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            {error}
          </p>
        )}
        {data && !data.settings.sync_enabled && (
          <p className="mb-5 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            The Meta catalog connection isn't enabled yet. Products can be prepared here; nothing is
            published to Meta until setup is complete.
          </p>
        )}

        {!data && !error && (
          <div className="grid gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        )}

        {data && total === 0 && (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border-strong bg-card px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-soft">
              <PackageOpen className="h-6 w-6" />
            </span>
            <div>
              <p className="font-medium">No products yet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Bring in the existing library from the website scrape, import a CSV, or add products
                one at a time.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    let remaining = 1;
                    let imported = 0;
                    while (remaining > 0) {
                      const r = await call({ action: "seed" });
                      remaining = r.remaining;
                      imported += r.added;
                    }
                    await reload();
                    toast.success(`Imported ${imported} products from the existing library`, {
                      description: "Review them before enabling catalog sync.",
                    });
                  })
                }
              >
                {busy ? <Loader2 className="animate-spin" /> : <PackageOpen />}
                Import existing library
              </Button>
              <Button variant="outline" onClick={() => setCsvOpen(true)}>
                <Upload />
                Import CSV
              </Button>
              <Button onClick={() => edit()}>
                <Plus />
                Add product
              </Button>
            </div>
          </div>
        )}

        {data && total > 0 && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="relative w-full max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  aria-label="Search products"
                  className={`${control} pl-9`}
                  placeholder="Search name, SKU, id or category"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--primary-strong)]"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                Include archived
              </label>
              <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                {rows.length === total ? `${total} products` : `${rows.length} of ${total}`}
              </span>
            </div>

            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              <Table>
                <TableHeader className="bg-secondary/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Product</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Availability</TableHead>
                    <TableHead>Meta sync</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={5}
                        className="py-12 text-center text-sm text-muted-foreground"
                      >
                        No products match “{query}”.
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((row) => {
                    const p = row.product;
                    const s = syncFor(p.id);
                    return (
                      <TableRow key={p.id} className={p.archived ? "opacity-60" : ""}>
                        <TableCell className="pl-4">
                          <div className="flex items-center gap-3">
                            {p.updated_image_link ? (
                              <img
                                loading="lazy"
                                src={p.updated_image_link}
                                alt=""
                                className="h-11 w-11 shrink-0 rounded-lg border border-border bg-background object-contain"
                              />
                            ) : (
                              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
                                <ImageOff className="h-4 w-4" />
                              </span>
                            )}
                            <div className="min-w-0 max-w-md">
                              <p className="truncate font-medium">{p.name}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {p.sku || p.id}
                                {p.category ? ` · ${p.category}` : ""}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {money(p.price, p.currency)}
                        </TableCell>
                        <TableCell>
                          {p.archived ? (
                            <Badge variant="outline" className="text-muted-foreground">
                              Archived
                            </Badge>
                          ) : p.in_stock ? (
                            <Badge
                              variant="secondary"
                              className="bg-emerald-400/15 text-emerald-900 hover:bg-emerald-400/15"
                            >
                              In stock
                            </Badge>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="bg-amber-400/15 text-amber-900 hover:bg-amber-400/15"
                            >
                              Out of stock
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="max-w-xs">
                          {s?.state === "synced" ? (
                            <Badge
                              variant="outline"
                              className="border-emerald-300 text-emerald-900"
                            >
                              Accepted by Meta
                            </Badge>
                          ) : s?.state === "failed" ? (
                            <Badge variant="outline" className="border-rose-300 text-rose-800">
                              Failed
                            </Badge>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              {s?.state ?? "Not queued"}
                            </span>
                          )}
                          {s?.last_error && (
                            <p className="mt-1 truncate text-xs text-rose-700" title={s.last_error}>
                              {s.last_error}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => edit(row)}
                          >
                            <Pencil />
                            Edit
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>

      <Sheet open={draft !== null} onOpenChange={(open) => !open && requestClose()}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
          {draft && (
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(e) => {
                e.preventDefault();
                setFormError("");
                void run(save, setFormError);
              }}
            >
              <SheetHeader className="border-b border-border px-6 py-5 text-left">
                <SheetTitle className="text-base">
                  {revision ? "Edit product" : "New product"}
                </SheetTitle>
                <SheetDescription>
                  {revision ? `Revision ${revision} · prices in USD` : "Prices in USD"}
                </SheetDescription>
              </SheetHeader>

              <fieldset disabled={busy} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                {formError && (
                  <p
                    role="alert"
                    className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
                  >
                    {formError}
                  </p>
                )}
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-medium">Product ID</span>
                    <input
                      className={control}
                      value={draft.id}
                      disabled={revision > 0}
                      onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    />
                    <span className="text-xs text-muted-foreground">
                      {revision > 0
                        ? "Permanent once saved."
                        : "Letters, numbers, dashes. Permanent once saved."}
                    </span>
                  </label>
                  {field("name", "Product name")}
                  {field("sku", "SKU")}
                  {field("category", "Category")}
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-medium">Price (USD)</span>
                    <input
                      className={control}
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={draft.price ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          price: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                    <span className="text-xs text-muted-foreground">
                      Leave blank only when unavailable. Meta requires a positive price.
                    </span>
                  </label>
                  {field("colour", "Colour / finish")}
                  {field("url", "Product page", {
                    hint: "HTTPS link to the page customers land on.",
                  })}
                  {field("source_image_link", "Original image", {
                    hint: "Where the photo came from. Kept for re-scrapes.",
                  })}
                  <div className="grid gap-1.5 sm:col-span-2">
                    {field("updated_image_link", "Image used by WhatsApp and Meta", {
                      hint: "A CDN URL. Imports fill this in automatically.",
                    })}
                    {draft.updated_image_link && /^https:\/\//.test(draft.updated_image_link) && (
                      <img
                        src={draft.updated_image_link}
                        alt="Product preview"
                        className="mt-1 h-44 w-full rounded-xl border border-border bg-background object-contain"
                        referrerPolicy="no-referrer"
                      />
                    )}
                  </div>
                  <div className="sm:col-span-2">
                    {field("chat_summary", "Short summary", {
                      multiline: true,
                      hint: "What the assistant says about it in chat. Up to 500 characters.",
                    })}
                  </div>
                  <div className="sm:col-span-2">
                    {field("description", "Full description", { multiline: true })}
                  </div>

                  <div className="flex flex-wrap gap-x-6 gap-y-3 sm:col-span-2">
                    {(
                      [
                        ["in_stock", "In stock"],
                        ["visualizable", "Available for room previews"],
                        ["archived", "Archived — hidden from new selections"],
                      ] as const
                    ).map(([key, text]) => (
                      <label className="flex items-center gap-2 text-sm" key={key}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--primary-strong)]"
                          checked={draft[key]}
                          onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                        />
                        {text}
                      </label>
                    ))}
                  </div>

                  <div className="sm:col-span-2">
                    <div className="mb-3 flex items-center justify-between">
                      <h4 className="text-sm font-medium">Specifications</h4>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setSpecs([...specs, ["", ""]])}
                      >
                        <Plus />
                        Add
                      </Button>
                    </div>
                    {specs.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                        No specifications yet. Seat height, base type, weight capacity — whatever a
                        buyer would ask.
                      </p>
                    ) : (
                      <div className="grid gap-2">
                        {specs.map(([k, v], i) => (
                          <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
                            <input
                              aria-label={`Specification ${i + 1} name`}
                              className={control}
                              placeholder="Name"
                              value={k}
                              onChange={(e) =>
                                setSpecs(
                                  specs.map((pair, j) => (j === i ? [e.target.value, v] : pair)),
                                )
                              }
                            />
                            <input
                              aria-label={`Specification ${i + 1} value`}
                              className={control}
                              placeholder="Value"
                              value={v}
                              onChange={(e) =>
                                setSpecs(
                                  specs.map((pair, j) => (j === i ? [k, e.target.value] : pair)),
                                )
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove specification ${i + 1}`}
                              onClick={() => setSpecs(specs.filter((_, j) => j !== i))}
                            >
                              ×
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </fieldset>

              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-6 py-4">
                <span className="text-xs text-muted-foreground">
                  {dirty ? "Unsaved changes" : " "}
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={requestClose} disabled={busy}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy && <Loader2 className="animate-spin" />}
                    {draft.archived
                      ? "Save and archive"
                      : revision
                        ? "Save changes"
                        : "Add product"}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this draft?"
        description="Your unsaved changes to this product will be lost. The saved version isn't affected."
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => {
          setConfirmDiscard(false);
          setDraft(null);
        }}
      />

      {data && (
        <ProductCsvDialog
          open={csvOpen}
          onOpenChange={setCsvOpen}
          existing={data.products}
          call={call}
          onDone={(s) => {
            void reload();
            if (s.failed.length === 0)
              toast.success(
                `Imported ${s.added + s.updated} product${s.added + s.updated === 1 ? "" : "s"}`,
                {
                  description: `${s.added} added · ${s.updated} updated · Meta updates queued separately.`,
                },
              );
            else
              toast.warning(
                `${s.failed.length} product${s.failed.length === 1 ? "" : "s"} didn't import`,
                {
                  description: `${s.added} added · ${s.updated} updated. Details are in the import window.`,
                },
              );
          }}
        />
      )}
    </section>
  );
}
