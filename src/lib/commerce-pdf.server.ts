import {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFName,
  PDFString,
  type PDFPage,
  type PDFFont,
  type PDFImage,
} from "pdf-lib";
import sharp from "sharp";
import { categoryLabel } from "@/lib/catalog";
import {
  comparisonFieldsFor,
  comparisonSummary,
  documentTotals,
  productSpec,
  usd,
  type CommerceDocument,
} from "@/lib/commerce-documents";

const ink = rgb(0.12, 0.15, 0.15),
  muted = rgb(0.37, 0.41, 0.41),
  gold = rgb(0.66, 0.49, 0.28),
  light = rgb(0.95, 0.95, 0.92);
const ascii = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7E\n]/g, " ");

export type ImageLoader = (url: string) => Promise<Uint8Array | null>;
export const loadProductImage: ImageLoader = async (url) => {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "comfortelfurniture.com" ||
      !parsed.pathname.startsWith("/wp-content/uploads/")
    )
      return null;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(6000) });
    if (!response.ok || Number(response.headers.get("content-length")) > 6_000_000) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 6_000_000) {
        await reader.cancel();
        return null;
      }
      parts.push(item.value);
    }
    return await sharp(Buffer.concat(parts), { limitInputPixels: 25_000_000 })
      .resize(420, 420, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 78 })
      .toBuffer();
  } catch {
    return null;
  }
};

export async function buildCommercePdf(
  data: CommerceDocument,
  images: ImageLoader = loadProductImage,
): Promise<Uint8Array> {
  if (
    !data.lines.length ||
    data.lines.length > 10 ||
    (data.kind === "comparison" && (data.lines.length < 2 || data.lines.length > 3))
  )
    throw new Error("Invalid document selection");
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(
    `Comfortel ${data.kind === "quote" ? "PDF quote - estimate" : "product comparison"} ${data.reference}`,
  );
  pdf.setAuthor("Comfortel");
  let page!: PDFPage;
  let y = 0;
  const width = data.kind === "comparison" ? 842 : 595;
  const height = data.kind === "comparison" ? 595 : 842;
  const margin = 36,
    usable = width - margin * 2;
  function text(
    value: string,
    x: number,
    top: number,
    size = 10,
    font: PDFFont = regular,
    color = ink,
  ) {
    page.drawText(ascii(value), { x, y: height - top - size, size, font, color });
  }
  function wrap(value: string, maxWidth: number, size = 10, font: PDFFont = regular): string[] {
    const lines: string[] = [];
    for (const paragraph of ascii(value).split("\n")) {
      let current = "";
      for (const word of paragraph.split(/\s+/)) {
        // Split long identifiers/URLs as well as ordinary words.
        let part = "";
        const chunks: string[] = [];
        for (const char of word) {
          if (font.widthOfTextAtSize(part + char, size) > maxWidth) {
            chunks.push(part);
            part = "";
          }
          part += char;
        }
        if (part) chunks.push(part);
        for (const chunk of chunks) {
          const next = current ? `${current} ${chunk}` : chunk;
          if (font.widthOfTextAtSize(next, size) > maxWidth && current) {
            lines.push(current);
            current = chunk;
          } else current = next;
        }
      }
      lines.push(current);
    }
    return lines;
  }
  function paragraph(
    value: string,
    x: number,
    top: number,
    maxWidth: number,
    size = 10,
    font = regular,
    color = ink,
  ) {
    const lines = wrap(value, maxWidth, size, font);
    lines.forEach((line, i) => text(line, x, top + i * (size + 4), size, font, color));
    return lines.length * (size + 4);
  }
  function link(label: string, url: string, x: number, top: number) {
    if (!url.startsWith("https://comfortelfurniture.com/")) return;
    text(label, x, top, 9, bold, gold);
    const annotation = pdf.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, height - top - 13, x + bold.widthOfTextAtSize(label, 9), height - top + 2],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    });
    page.node.addAnnot(pdf.context.register(annotation));
  }
  function newPage() {
    page = pdf.addPage([width, height]);
    page.drawRectangle({ x: 0, y: height - 10, width, height: 10, color: ink });
    text("COMFORTEL", margin, 28, 19, bold);
    text("SALON  /  BARBER  /  SPA", width - 205, 34, 8, regular, muted);
    text(
      data.kind === "quote" ? "Your furniture quote" : "Compare your shortlist",
      margin,
      66,
      25,
      bold,
    );
    text(
      data.kind === "quote"
        ? "BUDGET ESTIMATE  |  USD  |  NOT AN INVOICE"
        : "CATALOG COMPARISON  |  USD",
      margin,
      102,
      9,
      bold,
      gold,
    );
    text(
      `Document ${data.reference}  |  Prepared ${data.issuedAt}`,
      margin,
      121,
      9,
      regular,
      muted,
    );
    y = 150;
  }
  const loaded = await Promise.all(
    data.lines.map(async (l) => {
      const url = l.product.images[0];
      if (!url) return null;
      try {
        const bytes = await images(url);
        return bytes ? await pdf.embedJpg(bytes) : null;
      } catch {
        return null;
      }
    }),
  );
  function imageBox(image: PDFImage | null, x: number, top: number, w: number, h: number) {
    page.drawRectangle({
      x,
      y: height - top - h,
      width: w,
      height: h,
      color: rgb(1, 1, 1),
      borderWidth: 0.5,
      borderColor: light,
    });
    if (image) {
      const fitted = image.scaleToFit(w - 8, h - 8);
      page.drawImage(image, {
        x: x + (w - fitted.width) / 2,
        y: height - top - h + (h - fitted.height) / 2,
        width: fitted.width,
        height: fitted.height,
      });
    } else
      paragraph("Product image\nunavailable", x + 8, top + h / 2 - 12, w - 16, 8, regular, muted);
  }
  newPage();
  if (data.kind === "quote") {
    const totals = documentTotals(data.lines);
    y +=
      paragraph(
        `${data.lines.length} product${data.lines.length === 1 ? "" : "s"}, ${totals.pieces} pieces. Quantities reflect the selection used for this document. Prices are from the saved catalog, not a live offer.`,
        margin,
        y,
        usable,
        10,
        regular,
        muted,
      ) + 16;
    for (const [index, line] of data.lines.entries()) {
      if (y + 137 > height - 150) newPage();
      imageBox(loaded[index]!, margin, y, 85, 85);
      const left = margin + 100;
      const titleHeight = paragraph(line.product.name, left, y, usable - 100, 12, bold);
      text(
        `SKU: ${line.product.sku ?? line.product.id}  |  ${categoryLabel(line.product.category)}`,
        left,
        y + titleHeight + 4,
        9,
        regular,
        muted,
      );
      text(`Quantity: ${line.qty}`, left, y + titleHeight + 22, 10, bold);
      text(
        `Unit: ${line.unitCents === null ? "Price to confirm" : usd(line.unitCents)}`,
        left + 100,
        y + titleHeight + 22,
        10,
      );
      text(
        `Line: ${line.unitCents === null ? "To confirm" : usd(line.unitCents * line.qty)}`,
        left + 250,
        y + titleHeight + 22,
        10,
        bold,
      );
      link("View product & options", line.product.url, left, y + titleHeight + 44);
      y += Math.max(106, titleHeight + 74);
      page.drawLine({
        start: { x: margin, y: height - y },
        end: { x: width - margin, y: height - y },
        thickness: 0.5,
        color: light,
      });
      y += 14;
    }
    if (y + 200 > height - 50) newPage();
    page.drawRectangle({ x: margin, y: height - y - 62, width: usable, height: 62, color: light });
    text(
      totals.unknownPrices ? "Priced-items subtotal (incomplete)" : "Estimated furniture subtotal",
      margin + 14,
      y + 12,
      12,
      bold,
    );
    text(usd(totals.pricedSubtotal), width - margin - 125, y + 12, 18, bold);
    text(
      "Freight, tax, duties and installation: not included; to be confirmed.",
      margin + 14,
      y + 39,
      9,
    );
    y += 78;
    const note = totals.unknownPrices
      ? `${totals.unknownPrices} item(s) still need pricing. This is not a complete total. `
      : "";
    y +=
      paragraph(
        `${note}Before you order: our team needs to confirm current prices, selected options, availability, delivery costs and any applicable taxes. This estimate does not reserve stock or guarantee a delivery date.`,
        margin,
        y,
        usable,
        10,
      ) + 12;
    text("Ready for a confirmed quote?", margin, y, 12, bold);
    y += 20;
    paragraph(
      "Return to WhatsApp and choose Request final quote. Include your delivery postcode and any options you want checked. Keep this document reference handy.",
      margin,
      y,
      usable,
      10,
    );
  } else {
    const labelWidth = 117,
      gap = 10,
      col = (usable - labelWidth) / data.lines.length;
    const nameHeight =
      Math.max(...data.lines.map((l) => wrap(l.product.name, col - gap * 2, 11, bold).length)) * 15;
    for (const [index, line] of data.lines.entries()) {
      const x = margin + labelWidth + index * col;
      imageBox(loaded[index]!, x + gap, y, col - gap * 2, 70);
      paragraph(line.product.name, x + gap, y + 78, col - gap * 2, 11, bold);
      link("View product", line.product.url, x + gap, y + 86 + nameHeight);
    }
    y += 112 + nameHeight;
    const rows: [string, string[]][] = [
      [
        "Listed unit price",
        data.lines.map((l) => (l.unitCents === null ? "Price to confirm" : usd(l.unitCents))),
      ],
      ["SKU", data.lines.map((l) => l.product.sku ?? l.product.id)],
      ...comparisonFieldsFor(data.lines.map((l) => l.product)).map(
        ([label, keys]): [string, string[]] => [
          label,
          data.lines.map((l) => productSpec(l.product, keys)),
        ],
      ),
    ];
    const missingFields = rows
      .filter(([, values]) => values.every((v) => v === "Not listed - ask our team"))
      .map(([label]) => label);
    for (const [label, values] of rows.filter(([label]) => !missingFields.includes(label))) {
      const rowHeight =
        Math.max(
          wrap(label, labelWidth - 16, 9, bold).length,
          ...values.map((v) => wrap(v, col - 20, 9).length),
        ) *
          13 +
        12;
      if (y + rowHeight > height - 50) {
        newPage();
        data.lines.forEach((l, i) =>
          paragraph(
            l.product.name,
            margin + labelWidth + i * col + gap,
            y,
            col - gap * 2,
            10,
            bold,
          ),
        );
        y += 55;
      }
      page.drawRectangle({
        x: margin,
        y: height - y - rowHeight,
        width: usable,
        height: rowHeight,
        color: light,
      });
      paragraph(label, margin + 8, y + 6, labelWidth - 16, 9, bold);
      values.forEach((v, i) =>
        paragraph(v, margin + labelWidth + i * col + gap, y + 6, col - 20, 9),
      );
      y += rowHeight + 2;
    }
    const summary = comparisonSummary(data.lines);
    const note = `${missingFields.length ? `Not listed for these products: ${missingFields.join(", ").toLowerCase()}. ` : ""}Ask our team to confirm fit, selected options, availability, delivery costs and taxes before ordering. Prices and specifications are from the saved catalog and may change. Product links open the source pages.`;
    const guideHeight =
      20 + wrap(summary, usable, 10).length * 14 + 8 + wrap(note, usable, 10).length * 14;
    if (y + 18 + guideHeight > height - 45) newPage();
    else y += 18;
    text("How to choose", margin, y, 12, bold);
    y += 20;
    y += paragraph(summary, margin, y, usable, 10) + 8;
    paragraph(note, margin, y, usable, 10, regular, muted);
  }
  pdf.getPages().forEach((p, i) => {
    page = p;
    text("comfortelfurniture.com", margin, height - 29, 8, regular, muted);
    text(`${i + 1} / ${pdf.getPageCount()}`, width - margin - 32, height - 29, 8, regular, muted);
  });
  // Referencing PDFName here makes URI annotations easy to verify in tests.
  if (!pdf.getPages()[0]!.node.get(PDFName.of("Type"))) throw new Error("Invalid PDF page");
  return pdf.save();
}
