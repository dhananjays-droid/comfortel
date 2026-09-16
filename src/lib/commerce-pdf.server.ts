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
import { cdnFor } from "@/lib/cdn-assets";
import {
  comparisonFieldsFor,
  comparisonSummary,
  documentTotals,
  productSpec,
  usd,
  type CommerceDocument,
} from "@/lib/commerce-documents";

/**
 * The two customer-facing documents the WhatsApp flow sends: an itemised
 * estimate and a side-by-side comparison. Drawn directly with pdf-lib — no
 * HTML renderer on this deployment target — so layout is arithmetic here.
 *
 * Standard fonts only (Helvetica), which means WinAnsi text only; `ascii()`
 * folds anything the catalogue carries that Helvetica cannot draw.
 */

const ink = rgb(0.12, 0.15, 0.15),
  muted = rgb(0.37, 0.41, 0.41),
  gold = rgb(0.66, 0.49, 0.28),
  light = rgb(0.95, 0.95, 0.92),
  zebra = rgb(0.975, 0.975, 0.965),
  rule = rgb(0.84, 0.85, 0.83),
  paper = rgb(1, 1, 1);

const ascii = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7E\n]/g, " ");

export type ImageLoader = (url: string) => Promise<Uint8Array | null>;

/**
 * Hosts a product photo may be fetched from, and the path each must sit under.
 *
 * The vendor site is kept, but our CDN copy is tried FIRST. The vendor host is
 * the same one GPT Image 2 could not fetch from a datacenter, and from Vercel
 * it intermittently timed out here too — which surfaced to customers as
 * "Product image unavailable" boxes in an otherwise fine estimate. Every
 * catalogue photo is mirrored (scripts/sync-cdn-assets.mjs), so the CDN
 * answers for all of them; the vendor URL remains only as the fallback for a
 * product scraped since the last sync.
 */
const IMAGE_HOSTS: Record<string, string> = {
  "web-assets.quickads.ai": "/public-assets/",
  "comfortelfurniture.com": "/wp-content/uploads/",
};

const MAX_IMAGE_BYTES = 6_000_000;

function allowedImageUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    const prefix = IMAGE_HOSTS[parsed.hostname];
    if (parsed.protocol !== "https:" || !prefix || !parsed.pathname.startsWith(prefix)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchImage(url: URL): Promise<Uint8Array | null> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(6000) });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(item.value);
  }
  // Flattened onto white: the boxes below are white, and a transparent PNG
  // would otherwise embed as JPEG with a black background.
  return await sharp(Buffer.concat(parts), { limitInputPixels: 25_000_000 })
    .resize(480, 480, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export const loadProductImage: ImageLoader = async (url) => {
  const candidates = [cdnFor(url), url].filter((u): u is string => Boolean(u));
  for (const candidate of candidates) {
    const parsed = allowedImageUrl(candidate);
    if (!parsed) continue;
    try {
      const bytes = await fetchImage(parsed);
      if (bytes) return bytes;
    } catch {
      // Try the next source; a missing photo must never fail the document.
    }
  }
  return null;
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

  const quote = data.kind === "quote";
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(`Comfortel ${quote ? "estimate" : "product comparison"} ${data.reference}`);
  pdf.setAuthor("Comfortel");

  let page!: PDFPage;
  let y = 0;
  const width = quote ? 595 : 842;
  const height = quote ? 842 : 595;
  const margin = 36,
    usable = width - margin * 2,
    footerTop = height - 46;

  // ---- drawing helpers ---------------------------------------------------

  const measure = (value: string, size: number, font: PDFFont = regular) =>
    font.widthOfTextAtSize(ascii(value), size);

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

  function textRight(
    value: string,
    right: number,
    top: number,
    size = 10,
    font: PDFFont = regular,
    color = ink,
  ) {
    text(value, right - measure(value, size, font), top, size, font, color);
  }

  function textCenter(
    value: string,
    centerX: number,
    top: number,
    size = 10,
    font: PDFFont = regular,
    color = ink,
  ) {
    text(value, centerX - measure(value, size, font) / 2, top, size, font, color);
  }

  function wrap(value: string, maxWidth: number, size = 10, font: PDFFont = regular): string[] {
    const lines: string[] = [];
    for (const para of ascii(value).split("\n")) {
      let current = "";
      for (const word of para.split(/\s+/)) {
        // Long identifiers and URLs are split by character so they can never
        // push a column wider than the page.
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

  /** Line height used everywhere a paragraph is measured or drawn. */
  const leading = (size: number) => Math.round(size * 1.38);

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
    lines.forEach((line, i) => text(line, x, top + i * leading(size), size, font, color));
    return lines.length * leading(size);
  }

  const paragraphHeight = (value: string, maxWidth: number, size = 10, font = regular) =>
    wrap(value, maxWidth, size, font).length * leading(size);

  function link(label: string, url: string, x: number, top: number, size = 8.5) {
    if (!url.startsWith("https://comfortelfurniture.com/")) return;
    text(label, x, top, size, bold, gold);
    const w = measure(label, size, bold);
    page.drawLine({
      start: { x, y: height - top - size - 1.5 },
      end: { x: x + w, y: height - top - size - 1.5 },
      thickness: 0.6,
      color: gold,
    });
    const annotation = pdf.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, height - top - size - 4, x + w, height - top + 2],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    });
    page.node.addAnnot(pdf.context.register(annotation));
  }

  function box(x: number, top: number, w: number, h: number, fill = light, border?: typeof rule) {
    page.drawRectangle({
      x,
      y: height - top - h,
      width: w,
      height: h,
      color: fill,
      ...(border ? { borderWidth: 0.6, borderColor: border } : {}),
    });
  }

  function hline(top: number, x = margin, w = usable, color = rule, thickness = 0.6) {
    page.drawLine({
      start: { x, y: height - top },
      end: { x: x + w, y: height - top },
      thickness,
      color,
    });
  }

  /** A framed photo, or a quiet placeholder — never a wall of text. */
  function imageBox(image: PDFImage | null, x: number, top: number, w: number, h: number) {
    box(x, top, w, h, paper, rule);
    if (image) {
      const fitted = image.scaleToFit(w - 10, h - 10);
      page.drawImage(image, {
        x: x + (w - fitted.width) / 2,
        y: height - top - h + (h - fitted.height) / 2,
        width: fitted.width,
        height: fitted.height,
      });
    } else {
      box(x + 0.6, top + 0.6, w - 1.2, h - 1.2, zebra);
      textCenter("No photo", x + w / 2, top + h / 2 - 5, 8, regular, muted);
    }
  }

  // ---- page furniture ----------------------------------------------------

  const docLabel = quote ? "Estimate" : "Comparison";

  /** Brand strip shared by every page. */
  function brandBar() {
    page.drawRectangle({ x: 0, y: height - 8, width, height: 8, color: ink });
    text("COMFORTEL", margin, 26, 18, bold);
    textRight("SALON  /  BARBER  /  SPA", width - margin, 32, 7.5, regular, muted);
  }

  /** The first page carries the full title block and the document meta card. */
  function firstPage() {
    page = pdf.addPage([width, height]);
    brandBar();
    text(quote ? "Your furniture estimate" : "Compare your shortlist", margin, 64, 24, bold);
    text(
      quote ? "BUDGET ESTIMATE   |   USD   |   NOT AN INVOICE" : "CATALOG COMPARISON   |   USD",
      margin,
      98,
      8.5,
      bold,
      gold,
    );

    const cardW = 190,
      cardX = width - margin - cardW;
    box(cardX, 58, cardW, 62, light);
    text("DOCUMENT", cardX + 12, 66, 7, bold, muted);
    text(data.reference, cardX + 12, 76, 11, bold);
    text("PREPARED", cardX + 12, 94, 7, bold, muted);
    text(data.issuedAt, cardX + 12, 104, 9.5, regular);
    y = 128;
  }

  /** Continuation pages keep the brand and the reference, not the title. */
  function continuationPage() {
    page = pdf.addPage([width, height]);
    brandBar();
    textRight(
      `${docLabel} ${data.reference}   |   continued`,
      width - margin,
      47,
      8.5,
      regular,
      muted,
    );
    hline(60);
    y = 74;
  }

  const spaceLeft = () => footerTop - 12 - y;

  // ---- images (all in parallel, before any drawing) -----------------------

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

  firstPage();

  if (quote) {
    // ==================================================================
    // ESTIMATE
    // ==================================================================
    const totals = documentTotals(data.lines);
    const subtotalLabel = totals.unknownPrices
      ? "Priced subtotal (incomplete)"
      : "Estimated subtotal";

    // Summary tiles: the three numbers a buyer looks for first.
    const tiles: [string, string][] = [
      ["PRODUCTS", String(data.lines.length)],
      ["PIECES", String(totals.pieces)],
      [subtotalLabel.toUpperCase(), usd(totals.pricedSubtotal)],
    ];
    const tileGap = 10,
      tileW = (usable - tileGap * 2) / 3,
      tileH = 54;
    tiles.forEach(([label, value], i) => {
      const x = margin + i * (tileW + tileGap);
      box(x, y, tileW, tileH, light);
      text(label, x + 12, y + 11, 7, bold, muted);
      text(value, x + 12, y + 25, 16, bold, i === 2 && totals.unknownPrices ? gold : ink);
    });
    y += tileH + 10;
    y +=
      paragraph(
        "Quantities reflect the selection used for this document. Prices are from the saved catalog, not a live offer.",
        margin,
        y,
        usable,
        8.5,
        regular,
        muted,
      ) + 18;

    // Table geometry. Numeric columns are right-aligned to fixed edges so the
    // figures line up down the page.
    const lineRight = width - margin - 12,
      unitRight = lineRight - 92,
      qtyRight = unitRight - 74,
      thumb = 60,
      itemX = margin + thumb + 22,
      itemW = qtyRight - 40 - itemX;

    function tableHeader() {
      box(margin, y, usable, 20, light);
      text("ITEM", itemX, y + 6.5, 7.5, bold, muted);
      textRight("QTY", qtyRight, y + 6.5, 7.5, bold, muted);
      textRight("UNIT", unitRight, y + 6.5, 7.5, bold, muted);
      textRight("LINE TOTAL", lineRight, y + 6.5, 7.5, bold, muted);
      y += 20;
    }
    tableHeader();

    data.lines.forEach((line, index) => {
      const nameLines = wrap(line.product.name, itemW, 11, bold);
      const rowH = Math.max(thumb + 22, 12 + nameLines.length * leading(11) + 40);
      if (rowH > spaceLeft()) {
        continuationPage();
        tableHeader();
      }
      if (index % 2 === 1) box(margin, y, usable, rowH, zebra);

      imageBox(loaded[index] ?? null, margin + 8, y + 10, thumb, thumb);

      const textTop = y + 12;
      nameLines.forEach((l, i) => text(l, itemX, textTop + i * leading(11), 11, bold));
      const metaTop = textTop + nameLines.length * leading(11) + 3;
      text(
        `SKU ${line.product.sku ?? line.product.id}   |   ${categoryLabel(line.product.category)}`,
        itemX,
        metaTop,
        8,
        regular,
        muted,
      );
      link("View product & options", line.product.url, itemX, metaTop + 15);

      textRight(String(line.qty), qtyRight, textTop, 10.5, bold);
      if (line.unitCents === null) {
        textRight("To confirm", unitRight, textTop, 9, regular, muted);
        textRight("To confirm", lineRight, textTop, 9, regular, muted);
      } else {
        textRight(usd(line.unitCents), unitRight, textTop, 10, regular);
        textRight(usd(line.unitCents * line.qty), lineRight, textTop, 10.5, bold);
      }

      y += rowH;
      hline(y);
    });

    // Totals + caveats, kept together on one page.
    const caveat =
      "Our team still needs to confirm current prices, selected options, availability, delivery costs and any applicable taxes. This estimate does not reserve stock or guarantee a delivery date.";
    const totalsW = 250,
      totalsX = width - margin - totalsW,
      leftW = usable - totalsW - 24;
    const totalsH = totals.unknownPrices ? 112 : 96;
    const caveatH = 16 + paragraphHeight(caveat, leftW, 8.5);
    const nextH =
      30 +
      paragraphHeight(
        "Return to WhatsApp and tap Confirm delivery, or reply with your delivery postcode and any options you would like checked. Quote this document reference.",
        usable - 40,
        9,
      );
    y += 18;
    if (Math.max(totalsH, caveatH) + 18 + nextH > spaceLeft()) continuationPage();

    // Left: the caveat, quietly.
    text("BEFORE YOU ORDER", margin, y, 7, bold, muted);
    paragraph(caveat, margin, y + 14, leftW, 8.5, regular, muted);

    // Right: the money.
    box(totalsX, y, totalsW, totalsH, light);
    let ty = y + 12;
    text(subtotalLabel, totalsX + 14, ty, 8.5, bold, totals.unknownPrices ? gold : muted);
    textRight(usd(totals.pricedSubtotal), totalsX + totalsW - 14, ty + 12, 20, bold);
    ty += 44;
    hline(ty, totalsX + 14, totalsW - 28);
    ty += 10;
    text("Freight, tax, duties, installation", totalsX + 14, ty, 8.5, regular, muted);
    textRight("To be confirmed", totalsX + totalsW - 14, ty, 8.5, bold, ink);
    if (totals.unknownPrices) {
      ty += 16;
      text(
        `${totals.unknownPrices} item${totals.unknownPrices === 1 ? "" : "s"} still need${totals.unknownPrices === 1 ? "s" : ""} pricing - not a complete total`,
        totalsX + 14,
        ty,
        8,
        bold,
        gold,
      );
    }
    y += Math.max(totalsH, caveatH) + 18;

    // Next step: matches the button the customer actually sees under the PDF.
    box(margin, y, usable, nextH, light);
    box(margin, y, 3, nextH, gold);
    text("Ready for a confirmed quote?", margin + 18, y + 11, 11, bold);
    paragraph(
      "Return to WhatsApp and tap Confirm delivery, or reply with your delivery postcode and any options you would like checked. Quote this document reference.",
      margin + 18,
      y + 28,
      usable - 40,
      9,
    );
  } else {
    // ==================================================================
    // COMPARISON
    // ==================================================================
    const labelW = 128,
      gap = 12,
      col = (usable - labelW) / data.lines.length,
      colW = col - gap;
    const colX = (i: number) => margin + labelW + i * col + gap / 2;

    // Header cards: photo, name, price, SKU, link — the price lives here so it
    // is read once, prominently, instead of buried as the first table row.
    const photoH = 86;
    const nameH =
      Math.max(...data.lines.map((l) => wrap(l.product.name, colW - 20, 11, bold).length)) *
      leading(11);
    const cardH = 8 + photoH + 8 + nameH + 22 + 14 + 18 + 6;
    data.lines.forEach((line, i) => {
      const x = colX(i);
      box(x, y, colW, cardH, paper, rule);
      imageBox(loaded[i] ?? null, x + 10, y + 8, colW - 20, photoH);
      let cy = y + 8 + photoH + 8;
      paragraph(line.product.name, x + 10, cy, colW - 20, 11, bold);
      cy += nameH + 4;
      if (line.unitCents === null) text("Price to confirm", x + 10, cy, 11, bold, muted);
      else text(usd(line.unitCents), x + 10, cy, 14, bold);
      cy += 20;
      text(`SKU ${line.product.sku ?? line.product.id}`, x + 10, cy, 8, regular, muted);
      cy += 14;
      link("View product", line.product.url, x + 10, cy);
    });
    y += cardH + 16;

    const rows: [string, string[]][] = comparisonFieldsFor(data.lines.map((l) => l.product)).map(
      ([label, keys]): [string, string[]] => [
        label,
        data.lines.map((l) => productSpec(l.product, keys)),
      ],
    );
    const NOT_LISTED = "Not listed - ask our team";
    const missingFields = rows
      .filter(([, values]) => values.every((v) => v === NOT_LISTED))
      .map(([label]) => label);
    const shown = rows.filter(([label]) => !missingFields.includes(label));

    /** Slim column strip for continuation pages: names and prices only. */
    function columnStrip() {
      const h = nameH + 26;
      data.lines.forEach((line, i) => {
        const x = colX(i);
        paragraph(line.product.name, x + 10, y + 4, colW - 20, 10, bold);
        text(
          line.unitCents === null ? "Price to confirm" : usd(line.unitCents),
          x + 10,
          y + 4 + nameH + 2,
          9,
          regular,
          muted,
        );
      });
      y += h;
      hline(y, margin, usable, ink, 0.8);
      y += 4;
    }

    text("SPECIFICATION", margin + 10, y, 7, bold, muted);
    textRight(
      "A gold bar marks a row where the products differ",
      width - margin - 10,
      y,
      7,
      regular,
      muted,
    );
    y += 12;
    hline(y, margin, usable, ink, 0.8);
    y += 4;

    shown.forEach(([label, values], index) => {
      const rowH =
        Math.max(
          wrap(label, labelW - 20, 9, bold).length,
          ...values.map((v) => wrap(v, colW - 20, 9).length),
        ) *
          leading(9) +
        12;
      if (rowH > spaceLeft()) {
        continuationPage();
        columnStrip();
      }
      if (index % 2 === 0) box(margin, y, usable, rowH, zebra);
      const differs = new Set(values).size > 1;
      if (differs) box(margin, y, 2.5, rowH, gold);
      paragraph(label, margin + 12, y + 6, labelW - 20, 9, bold);
      values.forEach((v, i) =>
        paragraph(v, colX(i) + 10, y + 6, colW - 20, 9, regular, v === NOT_LISTED ? muted : ink),
      );
      y += rowH;
      hline(y);
    });

    // Guidance, kept as one block.
    const summary = comparisonSummary(data.lines);
    const note = `${
      missingFields.length
        ? `Not listed for these products: ${missingFields.join(", ").toLowerCase()}. `
        : ""
    }Ask our team to confirm fit, selected options, availability, delivery costs and taxes before ordering. Prices and specifications are from the saved catalog and may change. Product links open the source pages.`;
    const textW = usable - 40;
    const guideH =
      30 + paragraphHeight(summary, textW, 9.5) + 8 + paragraphHeight(note, textW, 8.5) + 14;
    y += 16;
    if (guideH > spaceLeft()) continuationPage();
    box(margin, y, usable, guideH, light);
    box(margin, y, 3, guideH, gold);
    text("How to choose", margin + 18, y + 11, 11, bold);
    let gy = y + 30;
    gy += paragraph(summary, margin + 18, gy, textW, 9.5) + 8;
    paragraph(note, margin + 18, gy, textW, 8.5, regular, muted);
  }

  // ---- footer on every page ----------------------------------------------

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    hline(footerTop, margin, usable);
    text("comfortelfurniture.com", margin, footerTop + 9, 7.5, regular, muted);
    textCenter(`${docLabel} ${data.reference}`, width / 2, footerTop + 9, 7.5, regular, muted);
    textRight(
      `Page ${i + 1} of ${pages.length}`,
      width - margin,
      footerTop + 9,
      7.5,
      regular,
      muted,
    );
  });

  // Referencing PDFName here makes URI annotations easy to verify in tests.
  if (!pages[0]!.node.get(PDFName.of("Type"))) throw new Error("Invalid PDF page");
  return pdf.save();
}
