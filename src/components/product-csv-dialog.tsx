import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { ManagedProduct, ProductRow } from "@/lib/product-management";
import {
  IMPORT_CHUNK,
  decodeCsvUpload,
  productsFromCsv,
  type ImportPlan,
  type ImportRow,
} from "@/lib/product-csv";
import { downloadSampleCsv, exportProductsCsv } from "@/lib/product-csv-download";

export type ImportOutcome = { id: string; status: "added" | "updated" | "failed"; error?: string };
export type ImportSummary = { added: number; updated: number; failed: ImportOutcome[] };

const FIELD_LABEL: Record<string, string> = {
  updated_image_link: "image",
  source_image_link: "source image",
  chat_summary: "summary",
  in_stock: "in stock",
  is_component: "component",
  dims_w_cm: "width (cm)",
  dims_d_cm: "depth (cm)",
  dims_h_cm: "height (cm)",
  salon_placement: "salon placement",
  product_type: "type",
  delivery_date: "delivery",
};
const label = (field: string) => FIELD_LABEL[field] ?? field.replaceAll("_", " ");
const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s || "—");

type Step = "pick" | "preview" | "importing" | "done";

/**
 * Import products from a CSV, in three deliberate steps: choose a file, see
 * exactly what will change and approve it, then watch it apply.
 *
 * The preview is the point. Nothing is written until the person has seen which
 * products are added, which fields change on which products, and which rows
 * can't be applied — and has read, in the same view, that nothing is deleted.
 */
export function ProductCsvDialog({
  open,
  onOpenChange,
  existing,
  call,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: ProductRow[];
  call: (body: unknown) => Promise<{ results?: ImportOutcome[] }>;
  onDone: (summary: ImportSummary) => void;
}) {
  const [step, setStep] = useState<Step>("pick");
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [readError, setReadError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(
    () => new Map<string, ManagedProduct>(existing.map((r) => [r.id, r.product])),
    [existing],
  );
  const groups = useMemo(() => {
    const rows = plan?.rows ?? [];
    return {
      adds: rows.filter((r) => r.kind === "add"),
      updates: rows.filter((r) => r.kind === "update" && r.changes.length > 0),
      unchanged: rows.filter((r) => r.kind === "update" && r.changes.length === 0),
      invalid: rows.filter((r) => r.kind === "invalid"),
    };
  }, [plan]);
  const toApply = [...groups.adds, ...groups.updates];

  function reset() {
    setStep("pick");
    setFileName("");
    setPlan(null);
    setSummary(null);
    setReadError("");
    setProgress({ done: 0, total: 0 });
  }
  function close(next: boolean) {
    if (!next && step === "importing") return; // never abandon a half-applied import silently
    onOpenChange(next);
    if (!next) reset();
  }

  async function readFile(file: File) {
    setReadError("");
    try {
      // Strict decode first: a file a spreadsheet saved in the wrong encoding
      // must be refused here, not reviewed as hundreds of "changes".
      const decoded = decodeCsvUpload(await file.arrayBuffer());
      if ("error" in decoded) {
        setReadError(decoded.error);
        return;
      }
      const next = productsFromCsv(decoded.text, byId);
      if (next.headerError) {
        setReadError(next.headerError);
        return;
      }
      setFileName(file.name);
      setPlan(next);
      setStep("preview");
    } catch {
      setReadError("That file couldn't be read. Export a CSV from here and edit that copy.");
    }
  }

  async function apply() {
    setStep("importing");
    setProgress({ done: 0, total: toApply.length });
    const result: ImportSummary = { added: 0, updated: 0, failed: [] };
    for (let i = 0; i < toApply.length; i += IMPORT_CHUNK) {
      const chunk = toApply.slice(i, i + IMPORT_CHUNK);
      try {
        const { results = [] } = await call({
          action: "import",
          products: chunk.map((r) => r.product),
        });
        for (const r of results) {
          if (r.status === "added") result.added++;
          else if (r.status === "updated") result.updated++;
          else result.failed.push(r);
        }
      } catch (err) {
        // A whole chunk failing (network, 5xx) is reported per row so the list
        // of what did not land is complete, not a single vague line.
        const message = err instanceof Error ? err.message : "Request failed";
        for (const r of chunk) result.failed.push({ id: r.id, status: "failed", error: message });
      }
      setProgress({ done: Math.min(i + chunk.length, toApply.length), total: toApply.length });
    }
    setSummary(result);
    setStep("done");
    onDone(result);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle className="text-base">
            {step === "pick" && "Import products from CSV"}
            {step === "preview" && "Review before importing"}
            {step === "importing" && "Importing…"}
            {step === "done" && "Import finished"}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {step === "pick" &&
              "Rows are matched to products by id. Existing products are updated, new ids are added. Nothing is ever deleted."}
            {step === "preview" && `${fileName} · nothing has been written yet`}
            {step === "importing" &&
              "Images are being copied to the CDN and products saved. Keep this open."}
            {step === "done" && "Here is what landed and what didn't."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === "pick" && (
            <div className="grid gap-5">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files[0];
                  if (f) void readFile(f);
                }}
                className="group flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border-strong bg-card px-6 py-12 text-center transition-colors hover:border-foreground/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-strong"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-soft text-foreground">
                  <Upload className="h-5 w-5" />
                </span>
                <span className="text-sm font-medium">Choose a CSV file, or drop one here</span>
                <span className="text-xs text-muted-foreground">
                  Same columns as an export. You'll review every change before it's applied.
                </span>
              </button>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readFile(f);
                  e.target.value = "";
                }}
              />
              {readError && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {readError}
                </p>
              )}
              <div className="grid gap-3 rounded-2xl border border-border bg-card p-5 text-sm">
                <p className="font-medium">How an import behaves</p>
                <ul className="grid gap-2 text-muted-foreground">
                  <li className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" />
                    A row whose{" "}
                    <code className="rounded bg-secondary px-1 text-xs text-foreground">id</code>{" "}
                    matches an existing product updates that product. A new id adds one.
                  </li>
                  <li className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" />
                    Products that aren't in the file are left exactly as they are. An import never
                    deletes or archives anything on its own.
                  </li>
                  <li className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" />
                    A column you leave out keeps its current value. A column you include always
                    applies — a blank cell clears that field.
                  </li>
                  <li className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" />
                    Every image URL is copied to our CDN during import; the product then uses the
                    CDN copy, and the original stays in{" "}
                    <code className="rounded bg-secondary px-1 text-xs text-foreground">
                      source_image_link
                    </code>
                    .
                  </li>
                </ul>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="button" variant="outline" size="sm" onClick={downloadSampleCsv}>
                    <FileSpreadsheet className="h-4 w-4" />
                    Download sample CSV
                  </Button>
                  {existing.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => exportProductsCsv(existing)}
                    >
                      <Download className="h-4 w-4" />
                      Export current products to edit
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === "preview" && plan && (
            <div className="grid gap-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="To add" value={groups.adds.length} tone="accent" />
                <Stat label="To update" value={groups.updates.length} tone="accent" />
                <Stat label="Unchanged" value={groups.unchanged.length} />
                <Stat
                  label="Can't import"
                  value={groups.invalid.length}
                  tone={groups.invalid.length ? "danger" : undefined}
                />
              </div>
              {plan.unknownColumns.length > 0 && (
                <p className="flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Ignoring columns this importer doesn't know:{" "}
                    {plan.unknownColumns.map((c) => (
                      <code key={c} className="mr-1 rounded bg-amber-100 px-1 text-xs">
                        {c}
                      </code>
                    ))}
                    Check for a typo if one of these was meant to update something.
                  </span>
                </p>
              )}
              <p className="rounded-xl bg-secondary/60 px-4 py-3 text-sm">
                <span className="font-medium">Nothing is deleted.</span> The{" "}
                {existing.length - groups.updates.length - groups.unchanged.length} products not in
                this file stay exactly as they are.
              </p>

              {groups.invalid.length > 0 && (
                <Section
                  title={`${groups.invalid.length} row${groups.invalid.length === 1 ? "" : "s"} can't be imported`}
                  tone="danger"
                >
                  {groups.invalid.map((r) => (
                    <li key={`${r.line}-${r.id}`} className="grid gap-1 px-4 py-3">
                      <div className="flex items-baseline gap-2 text-sm">
                        <span className="font-mono text-xs text-muted-foreground">
                          line {r.line}
                        </span>
                        <span className="font-medium">{r.id || "no id"}</span>
                      </div>
                      <ul className="grid gap-0.5 text-xs text-rose-800">
                        {r.errors.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </Section>
              )}
              {groups.updates.length > 0 && (
                <Section
                  title={`${groups.updates.length} product${groups.updates.length === 1 ? "" : "s"} will change`}
                >
                  {groups.updates.map((r) => (
                    <ChangeRow key={r.id} row={r} name={byId.get(r.id)?.name ?? r.id} />
                  ))}
                </Section>
              )}
              {groups.adds.length > 0 && (
                <Section
                  title={`${groups.adds.length} new product${groups.adds.length === 1 ? "" : "s"}`}
                >
                  {groups.adds.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{r.product?.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {r.id}
                          {r.product?.category ? ` · ${r.product.category}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {r.product?.price === null || r.product?.price === undefined
                          ? "No price"
                          : `$${r.product.price.toLocaleString("en-US")}`}
                      </span>
                    </li>
                  ))}
                </Section>
              )}
              {groups.unchanged.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {groups.unchanged.length} row{groups.unchanged.length === 1 ? " is" : "s are"}{" "}
                  identical to what's already saved and will be skipped.
                </p>
              )}
            </div>
          )}

          {step === "importing" && (
            <div className="grid gap-4 py-6">
              <div className="flex items-center gap-3 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span>
                  {progress.done} of {progress.total} products
                </span>
              </div>
              <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
              <p className="text-xs text-muted-foreground">
                Each product's images are uploaded to the CDN before it's saved, so this can take a
                few seconds per product.
              </p>
            </div>
          )}

          {step === "done" && summary && (
            <div className="grid gap-5">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Added" value={summary.added} tone="accent" />
                <Stat label="Updated" value={summary.updated} tone="accent" />
                <Stat
                  label="Failed"
                  value={summary.failed.length}
                  tone={summary.failed.length ? "danger" : undefined}
                />
              </div>
              {summary.failed.length > 0 ? (
                <Section title="Not imported" tone="danger">
                  {summary.failed.map((f, i) => (
                    <li key={`${f.id}-${i}`} className="grid gap-0.5 px-4 py-3 text-sm">
                      <span className="font-medium">{f.id}</span>
                      <span className="text-xs text-rose-800">{f.error}</span>
                    </li>
                  ))}
                </Section>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Everything in the file is saved. Meta catalog updates are queued separately, as
                  with any edit.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4 sm:justify-between">
          {step === "preview" ? (
            <>
              <Button type="button" variant="ghost" onClick={reset}>
                Choose a different file
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => close(false)}>
                  Cancel
                </Button>
                <Button type="button" disabled={toApply.length === 0} onClick={() => void apply()}>
                  Import {toApply.length} product{toApply.length === 1 ? "" : "s"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          ) : step === "done" ? (
            <Button type="button" className="ml-auto" onClick={() => close(false)}>
              Done
            </Button>
          ) : step === "pick" ? (
            <Button
              type="button"
              variant="outline"
              className="ml-auto"
              onClick={() => close(false)}
            >
              Cancel
            </Button>
          ) : (
            <span className="ml-auto text-xs text-muted-foreground">Please wait…</span>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "accent" | "danger" | undefined;
}) {
  return (
    <div
      className={
        "rounded-xl px-4 py-3 " +
        (tone === "danger" && value > 0
          ? "bg-rose-50 text-rose-900"
          : tone === "accent" && value > 0
            ? "bg-primary-soft text-foreground"
            : "bg-secondary/60 text-foreground")
      }
    >
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        "overflow-hidden rounded-2xl border " +
        (tone === "danger" ? "border-rose-200" : "border-border")
      }
    >
      <h3
        className={
          "px-4 py-2.5 text-xs font-medium " +
          (tone === "danger" ? "bg-rose-50 text-rose-900" : "bg-secondary/40 text-muted-foreground")
        }
      >
        {title}
      </h3>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

function ChangeRow({ row, name }: { row: ImportRow; name: string }) {
  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate font-medium">{name}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.id}</span>
      </div>
      <ul className="grid gap-1">
        {row.changes.map((c) => (
          <li
            key={c.field}
            className="grid grid-cols-[7rem_1fr] items-baseline gap-2 text-xs sm:grid-cols-[8rem_1fr]"
          >
            <span className="text-muted-foreground">{label(c.field)}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span
                className="truncate text-muted-foreground line-through decoration-muted-foreground/60"
                title={c.from}
              >
                {short(c.from)}
              </span>
              <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium" title={c.to}>
                {short(c.to)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}
