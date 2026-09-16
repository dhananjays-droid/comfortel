/**
 * Browser-side file handoffs for the product CSV. Kept out of the dialog
 * component so that file exports only components (fast refresh) and so the
 * product manager can offer "Export CSV" without mounting the import dialog.
 */
import type { ProductRow } from "@/lib/product-management";
import { sampleCsv, serializeProductsCsv } from "@/lib/product-csv";

/** Hands the browser a file to save. The blob URL is revoked once the click has fired. */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportProductsCsv(rows: ProductRow[]) {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`comfortel-products-${stamp}.csv`, serializeProductsCsv(rows.map((r) => r.product)));
}

export function downloadSampleCsv() {
  downloadText("comfortel-products-sample.csv", sampleCsv());
}
