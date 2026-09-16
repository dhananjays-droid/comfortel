/**
 * Browser-side file handoffs for the product CSV. Kept out of the dialog
 * component so that file exports only components (fast refresh) and so the
 * product manager can offer "Export CSV" without mounting the import dialog.
 */
import type { ProductRow } from "@/lib/product-management";
import { sampleCsv, serializeProductsCsv } from "@/lib/product-csv";

/**
 * Hands the browser a file to save. The blob URL is revoked once the click has fired.
 *
 * The byte-order mark is not decoration. Without it Excel for Mac guesses the
 * encoding of a .csv, guesses MacRoman, and re-saves every "–" and "’" as
 * mojibake — which is how a two-price edit once came back as 261 changed
 * cells. With it, Excel opens the file as UTF-8. parseCsv strips it on the
 * way back in.
 */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["\uFEFF" + text], { type }));
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
