import { describe, expect, it } from "vitest";
import raw from "@/data/catalog-full.json";
import { managedProductSchema, type ManagedProduct } from "@/lib/product-management";
import {
  CSV_COLUMNS,
  decodeCsvUpload,
  parseCsv,
  productsFromCsv,
  sampleCsv,
  serializeProductsCsv,
} from "@/lib/product-csv";

const seed = Object.values(raw)
  .slice(0, 3)
  .map((p) =>
    managedProductSchema
      .innerType()
      .strip()
      .parse({
        ...p,
        currency: "USD",
        source_image_link: p.images[0],
        updated_image_link: p.images[0],
        archived: false,
        visualizable: true,
        chat_summary: "Short summary",
        colour: "black",
        specs: { "Seat height": "45-60 cm", Base: "5-star, black" },
        dims_cm: { w: 60, d: 70, h: 110 },
      }),
  ) as ManagedProduct[];
const existing = new Map(seed.map((p) => [p.id, p]));

describe("CSV round trip", () => {
  it("exports every product field in the fixed column order", () => {
    const [header] = serializeProductsCsv(seed).split("\r\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
    expect(CSV_COLUMNS[0]).toBe("id");
    expect(CSV_COLUMNS).toContain("specs");
    expect(CSV_COLUMNS).toContain("dims_w_cm");
  });
  it("re-importing an export changes nothing", () => {
    const { rows, headerError } = productsFromCsv(serializeProductsCsv(seed), existing);
    expect(headerError).toBeUndefined();
    expect(rows.map((r) => r.kind)).toEqual(["update", "update", "update"]);
    for (const row of rows) {
      expect(row.changes).toEqual([]);
      expect(row.product).toEqual(existing.get(row.id));
    }
  });
  it("survives commas, quotes and newlines inside a field", () => {
    const tricky = { ...seed[0]!, name: 'Chair "Aria", tan\nsecond line', id: "trick-1" };
    const { rows } = productsFromCsv(serializeProductsCsv([tricky]), new Map());
    expect(rows[0]!.kind).toBe("add");
    expect(rows[0]!.product!.name).toBe(tricky.name);
  });
});

describe("parseCsv", () => {
  it("parses RFC 4180 quoting and reports the source line of each row", () => {
    const parsed = parseCsv('a,b\r\n1,"x, ""y""\nz"\r\n2,plain\r\n');
    expect(parsed.header).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([
      { line: 2, cells: ["1", 'x, "y"\nz'] },
      { line: 4, cells: ["2", "plain"] },
    ]);
  });
});

describe("productsFromCsv", () => {
  // A product needs a page URL and, unless archived, an image — the schema's
  // rules, so a brand-new row has to supply both.
  const header = "id,name,price,url,updated_image_link";
  it("adds an unknown id and updates a known one, describing each changed field", () => {
    const p = seed[0]!;
    const text = `${header}\n${p.id},${p.name},${(p.price ?? 0) + 10},${p.url},${p.updated_image_link}\nnew-1,Brand new chair,199,https://example.com/new,https://example.com/new.jpg`;
    const { rows } = productsFromCsv(text, existing);
    expect(rows[0]!.kind).toBe("update");
    expect(rows[0]!.changes).toEqual([
      { field: "price", from: String(p.price), to: String((p.price ?? 0) + 10) },
    ]);
    expect(rows[1]!.kind).toBe("add");
    expect(rows[1]!.product).toMatchObject({ id: "new-1", name: "Brand new chair", price: 199 });
  });
  it("keeps every value the file does not mention, and clears a present blank", () => {
    const p = seed[0]!;
    const { rows } = productsFromCsv(`id,mrp\n${p.id},`, existing);
    expect(rows[0]!.product!.name).toBe(p.name);
    expect(rows[0]!.product!.specs).toEqual(p.specs);
    expect(rows[0]!.product!.mrp).toBeNull();
  });
  it("reads specs as one 'Key: value' per line or separated by semicolons", () => {
    const id = seed[0]!.id;
    const a = productsFromCsv(`id,specs\n${id},"Seat height: 45 cm\nBase: 5-star"`, existing);
    const b = productsFromCsv(`id,specs\n${id},Seat height: 45 cm; Base: 5-star`, existing);
    const want = { "Seat height": "45 cm", Base: "5-star" };
    expect(a.rows[0]!.product?.specs ?? a.rows[0]!.errors).toEqual(want);
    expect(b.rows[0]!.product?.specs ?? b.rows[0]!.errors).toEqual(want);
  });
  it("reads pipe-separated images and the three dimension columns", () => {
    const { rows } = productsFromCsv(
      `id,images,dims_w_cm,dims_d_cm,dims_h_cm\n${seed[0]!.id},https://a.example/1.jpg|https://a.example/2.jpg,60,70,`,
      existing,
    );
    expect(rows[0]!.product!.images).toEqual([
      "https://a.example/1.jpg",
      "https://a.example/2.jpg",
    ]);
    expect(rows[0]!.product!.dims_cm).toEqual({ w: 60, d: 70, h: null });
  });
  it("marks a row invalid with its line number and reason instead of dropping it silently", () => {
    const { rows } = productsFromCsv(
      `id,name,price\n${seed[0]!.id},Ok name,-5\n,No id,10`,
      existing,
    );
    expect(rows[0]!.kind).toBe("invalid");
    expect(rows[0]!.line).toBe(2);
    expect(rows[0]!.errors.join(" ")).toMatch(/price/i);
    expect(rows[1]!.kind).toBe("invalid");
    expect(rows[1]!.errors.join(" ")).toMatch(/id/i);
  });
  it("refuses a file whose header has no id column", () => {
    expect(productsFromCsv("name,price\nx,1", existing).headerError).toMatch(/id/);
  });
  it("flags a duplicate id inside one file rather than applying it twice", () => {
    const { rows } = productsFromCsv(`id,name\nnew-3,First\nnew-3,Second`, new Map());
    expect(rows[1]!.kind).toBe("invalid");
    expect(rows[1]!.errors.join(" ")).toMatch(/duplicate/i);
  });
});

describe("sampleCsv", () => {
  it("is a complete, valid example that imports as additions", () => {
    const { rows, headerError } = productsFromCsv(sampleCsv(), new Map());
    expect(headerError).toBeUndefined();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.kind === "add")).toBe(true);
  });
});

describe("specs with semicolons inside a value", () => {
  // The exact shape that broke a real re-import: component parts carry a
  // single "Listed with" spec naming every chair they fit, separated by ";".
  const part = {
    ...seed[0]!,
    id: "330036",
    name: "Omega Round Black",
    specs: { "Listed with": "Roxanne Styling Chair; Dawn Sage Styling Chair; Blake Styling Chair" },
  };

  it("survives an export -> import round trip untouched", () => {
    const existing = new Map([[part.id, part]]);
    const { rows } = productsFromCsv(serializeProductsCsv([part]), existing);
    expect(rows[0]!.errors ?? []).toEqual([]);
    expect(rows[0]!.product!.specs).toEqual(part.specs);
  });

  it("still splits a hand-typed single line at each new 'Name:'", () => {
    const existing = new Map([[part.id, part]]);
    const { rows } = productsFromCsv(
      `id,specs\n${part.id},Listed with: Chair A; Chair B; Seat height: 45 cm; Base: 5-star`,
      existing,
    );
    expect(rows[0]!.product?.specs ?? rows[0]!.errors).toEqual({
      "Listed with": "Chair A; Chair B",
      "Seat height": "45 cm",
      Base: "5-star",
    });
  });
});

describe("files a spreadsheet has been through", () => {
  it("refuses a file saved in Windows-1252 instead of UTF-8, and says why", () => {
    // Excel for Mac's plain "CSV" save: the en dash becomes a single 0x96 byte.
    const bytes = Buffer.from("id,name\n300024,Double Bench \x96 Natural Ash\n", "latin1");
    const result = decodeCsvUpload(bytes);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/UTF-8/);
      expect(result.error).toMatch(/Nothing has been changed/);
    }
  });

  it("accepts a UTF-8 file with a byte-order mark and parses it cleanly", () => {
    const p = seed[0]!;
    const bytes = new TextEncoder().encode(`\uFEFFid,name\n${p.id},Double Bench – Natural Ash\n`);
    const result = decodeCsvUpload(bytes);
    expect("text" in result).toBe(true);
    if ("text" in result) {
      // A BOM must not turn the first header into "\uFEFFid" and break matching.
      const { rows, headerError } = productsFromCsv(result.text, new Map([[p.id, p]]));
      expect(headerError).toBeUndefined();
      expect(rows[0]!.product?.name).toBe("Double Bench – Natural Ash");
      expect(rows[0]!.changes.map((c) => c.field)).toEqual(["name"]);
    }
  });

  it("treats a spreadsheet's 'Feb-27' as the unchanged 'February 2027'", () => {
    const p = { ...seed[0]!, delivery_date: "February 2027" };
    const existing = new Map([[p.id, p]]);
    const same = productsFromCsv(`id,delivery_date\n${p.id},Feb-27`, existing);
    expect(same.rows[0]!.changes).toEqual([]);
    expect(same.rows[0]!.product?.delivery_date).toBe("February 2027");
    // A genuinely different month is still a change.
    const moved = productsFromCsv(`id,delivery_date\n${p.id},Mar-27`, existing);
    expect(moved.rows[0]!.changes.map((c) => c.field)).toEqual(["delivery_date"]);
  });

  it("does not count TRUE/FALSE as a change to a boolean", () => {
    const p = seed[0]!;
    const csv = serializeProductsCsv([p])
      .replace(/,true,/g, ",TRUE,")
      .replace(/,false,/g, ",FALSE,");
    const { rows } = productsFromCsv(csv, new Map([[p.id, p]]));
    expect(rows[0]!.changes).toEqual([]);
  });
});
