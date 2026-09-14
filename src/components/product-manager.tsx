import { useCallback, useEffect, useMemo, useState } from "react";
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
const blank = (): ManagedProduct => ({
  id: "",
  name: "",
  price: null,
  mrp: null,
  url: "",
  images: [],
  description: "",
  specs: {},
  dims_cm: null,
  placement: null,
  in_stock: true,
  category: "",
  sku: "",
  product_type: null,
  is_component: false,
  delivery_date: null,
  salon_placement: null,
  replaces: null,
  source_image_link: "",
  updated_image_link: "",
  archived: false,
  visualizable: false,
  currency: "USD",
  chat_summary: "",
  colour: "",
});
const control = "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm";
const button =
  "rounded-xl border border-border px-4 py-2 text-sm disabled:opacity-50 hover:bg-secondary";
export function ProductManager({
  token,
  onEditingChange,
}: {
  token: string;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [data, setData] = useState<Data | null>(null),
    [query, setQuery] = useState(""),
    [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<ManagedProduct | null>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [specs, setSpecs] = useState<[string, string][]>([]);
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
  const reload = useCallback(async () => {
    setData((await call()) as Data);
  }, [call]);
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [reload]);
  useEffect(() => {
    if (!draft) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
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
            .includes(query.toLowerCase()),
      ) ?? [],
    [data, query, showArchived],
  );
  function edit(row?: ProductRow) {
    setDraft(row ? structuredClone(row.product) : blank());
    setRevision(row?.revision ?? 0);
    setSpecs(Object.entries(row?.product.specs ?? {}));
    setError("");
    setMessage("");
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
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
    setMessage("Saved to the product database. Meta updates are queued separately.");
    await reload();
  }
  function field(key: keyof ManagedProduct, label: string, multiline = false) {
    if (!draft) return null;
    const props = {
      className: control,
      value: String(draft[key] ?? ""),
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft({ ...draft, [key]: e.target.value }),
    };
    return (
      <label className="grid gap-1.5 text-sm">
        {label}
        {multiline ? <textarea {...props} rows={3} /> : <input {...props} />}
      </label>
    );
  }
  return (
    <section className="h-full overflow-y-auto p-5 md:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Products</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One product library for WhatsApp, quotes and the Meta catalog.
          </p>
        </div>
        <div className="flex gap-2">
          <button className={button} disabled={busy || !!draft} onClick={() => void run(reload)}>
            Refresh
          </button>
          <button
            className={button}
            disabled={busy || !!draft}
            onClick={() =>
              void run(async () => {
                const r = await call({ action: "sync" });
                setMessage(
                  r.configured
                    ? `Meta accepted ${r.synced} updates; ${r.failed} failed. Remaining changes stay queued. Catalog review may take longer.`
                    : r.message,
                );
                await reload();
              })
            }
          >
            Sync now
          </button>
          <button
            className={`${button} bg-primary`}
            disabled={busy || !!draft}
            onClick={() => edit()}
          >
            Add product
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-rose-50 p-4 text-sm text-rose-800">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mb-4 rounded-xl bg-secondary p-4 text-sm">
          {message}
        </p>
      )}
      {data && !data.settings.sync_enabled && (
        <p className="mb-5 rounded-xl border border-border bg-card p-4 text-sm">
          Meta catalog connection is not enabled. You can prepare products here; nothing will be
          published to Meta until setup is complete.
        </p>
      )}
      {data?.products.length === 0 && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              let remaining = 1,
                total = 0;
              while (remaining > 0) {
                const r = await call({ action: "seed" });
                remaining = r.remaining;
                total += r.added;
                setMessage(`Imported ${total} products. ${remaining} remaining…`);
              }
              await reload();
              setMessage("Existing products imported. Review them before enabling catalog sync.");
            })
          }
        >
          Import existing product library
        </button>
      )}
      {draft ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(save);
          }}
          className="rounded-2xl border border-border bg-card p-6"
        >
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-lg font-semibold">{revision ? "Edit product" : "New product"}</h3>
            <span className="text-sm text-muted-foreground">
              {revision ? `Revision ${revision}` : "USD prices"}
            </span>
          </div>
          <fieldset disabled={busy} className="grid gap-5 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              Product ID (permanent)
              <input
                className={control}
                value={draft.id}
                disabled={revision > 0}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              />
            </label>
            {field("name", "Product name")}
            {field("sku", "SKU")}
            {field("category", "Category")}
            <label className="grid gap-1.5 text-sm">
              Price (USD)
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
            {field("url", "Product page (HTTPS)")}
            {field("source_image_link", "Original source image (HTTPS)")}
            {field("updated_image_link", "Image used by WhatsApp and Meta (CDN URL)")}
            {draft.updated_image_link && /^https:\/\//.test(draft.updated_image_link) && (
              <img
                src={draft.updated_image_link}
                alt="Product preview"
                className="h-40 w-full rounded-xl bg-background object-contain"
                referrerPolicy="no-referrer"
              />
            )}
            {field("chat_summary", "Short product summary", true)}
            {field("description", "Full description", true)}
            <div className="flex flex-wrap gap-5 md:col-span-2">
              {(["in_stock", "visualizable", "archived"] as const).map((key) => (
                <label className="flex items-center gap-2 text-sm" key={key}>
                  <input
                    type="checkbox"
                    checked={draft[key]}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                  />
                  {
                    {
                      in_stock: "In stock",
                      visualizable: "Available for room previews",
                      archived: "Archived — hide from new selections",
                    }[key]
                  }
                </label>
              ))}
            </div>
            <div className="md:col-span-2">
              <h4 className="mb-3 font-medium">Specifications</h4>
              <div className="space-y-2">
                {specs.map(([k, v], i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      aria-label={`Specification ${i + 1} name`}
                      className={control}
                      value={k}
                      onChange={(e) =>
                        setSpecs(specs.map((pair, j) => (j === i ? [e.target.value, v] : pair)))
                      }
                    />
                    <input
                      aria-label={`Specification ${i + 1} value`}
                      className={control}
                      value={v}
                      onChange={(e) =>
                        setSpecs(specs.map((pair, j) => (j === i ? [k, e.target.value] : pair)))
                      }
                    />
                    <button
                      type="button"
                      aria-label={`Remove specification ${i + 1}`}
                      className={button}
                      onClick={() => setSpecs(specs.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className={`${button} mt-3`}
                onClick={() => setSpecs([...specs, ["", ""]])}
              >
                Add specification
              </button>
            </div>
            <div className="flex gap-3 md:col-span-2">
              <button className={`${button} bg-primary`} type="submit">
                {busy ? "Saving…" : draft.archived ? "Save and archive" : "Save product"}
              </button>
              <button
                className={button}
                type="button"
                onClick={() => {
                  if (window.confirm("Discard this unsaved product draft?")) setDraft(null);
                }}
              >
                Cancel
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-4">
            <input
              aria-label="Search products"
              className={`${control} max-w-md`}
              placeholder="Search name, SKU or category…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Include archived
            </label>
            <span className="text-sm text-muted-foreground">{rows.length} products</span>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-secondary/40 text-muted-foreground">
                <tr>
                  {["Product", "Price", "Availability", "Meta sync", ""].map((t, i) => (
                    <th key={i} className="px-4 py-3 font-medium">
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const p = row.product,
                    s = data?.sync.find((s) => s.product_id === p.id);
                  return (
                    <tr key={p.id} className="border-t border-border">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <img
                            loading="lazy"
                            src={p.updated_image_link || undefined}
                            alt=""
                            className="h-12 w-12 rounded-lg bg-background object-contain"
                          />
                          <div className="max-w-sm">
                            <p className="font-medium">{p.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {p.sku || p.id} · {p.category}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {p.price === null
                          ? "Not set"
                          : new Intl.NumberFormat("en-US", {
                              style: "currency",
                              currency: p.currency,
                            }).format(p.price)}
                      </td>
                      <td className="px-4 py-3">
                        {p.archived ? "Archived" : p.in_stock ? "In stock" : "Out of stock"}
                      </td>
                      <td className="max-w-xs px-4 py-3">
                        <span
                          className={
                            s?.state === "failed" ? "text-rose-700" : "text-muted-foreground"
                          }
                        >
                          {s?.state === "synced" ? "Accepted by Meta" : (s?.state ?? "Not queued")}
                        </span>
                        {s?.last_error && (
                          <p className="mt-1 text-xs text-rose-700">{s.last_error}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button className={button} disabled={busy} onClick={() => edit(row)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!data && !error && (
            <p className="py-8 text-center text-muted-foreground">Loading products…</p>
          )}
        </>
      )}
    </section>
  );
}
