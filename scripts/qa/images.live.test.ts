import { test, vi, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("QA: production database forbidden");
      },
    },
  ),
}));
import { CATALOG_FULL, SLIM_BY_ID } from "@/lib/catalog";
import { viewsFor } from "@/lib/product-views";
import { resolveDims } from "@/lib/dims";
import { buildRenderRequest, type VisualizeMode } from "@/lib/visualize-prompt";
import { createVisualizeTask, getTaskResult, KIE_IMAGE_MODEL } from "@/lib/kie.server";
import { runInspectRender } from "@/lib/render-qa.functions";
import { inspectWhatsAppEdit } from "@/lib/wa-edit-check.server";
import { whatsappImagePrompt } from "@/lib/wa-image-scope";

test.skipIf(process.env.COMFORTEL_IMAGE_QA !== "yes")(
  "3 live image regression cases, test-only scenes and no customer delivery",
  async () => {
    const env = parseEnv(readFileSync(".env", "utf8"));
    process.env.KIE_API_KEY = env.KIE_API_KEY;
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    const out = "outputs/qa-2026-09-14-after";
    const sources = JSON.parse(readFileSync("outputs/qa-2026-09-14/images.json", "utf8")).results;
    mkdirSync(out, { recursive: true });
    const results: any[] = existsSync(`${out}/images.json`)
      ? JSON.parse(readFileSync(`${out}/images.json`, "utf8")).results
      : [];
    const save = () =>
      writeFileSync(
        `${out}/images.json`,
        JSON.stringify(
          { model: KIE_IMAGE_MODEL, resolution: "1K", productionWrites: false, results },
          null,
          2,
        ),
      );
    const product = (name: string) => {
      const p = Object.values(CATALOG_FULL).find(
        (p) => p.name.toLowerCase().includes(name.toLowerCase()) && !p.is_component,
      );
      if (!p) throw new Error(`Missing QA product ${name}`);
      return {
        ...p,
        col: SLIM_BY_ID[p.id]?.col ?? null,
        dims_cm: resolveDims(p),
        views: viewsFor(p.id),
      };
    };
    const chair = product("Chloe Tan"),
      mirror = product("Nero Round"),
      barber = Object.values(CATALOG_FULL).find((p) => p.name === "Crow Barbers Chair")!;
    if (!barber) throw new Error("No black barber fixture");
    const black = product(barber.name);
    const whiteCandidate = Object.values(CATALOG_FULL).find(
      (p) =>
        p.category === "salon/styling-chairs" &&
        /white/i.test(SLIM_BY_ID[p.id]?.col ?? "") &&
        !p.is_component,
    )!;
    const white = product(whiteCandidate.name);
    const desk = product(
      Object.values(CATALOG_FULL).find(
        (p) => p.category === "salon/reception-desks" && !p.is_component,
      )!.name,
    );
    const trolley = product(
      Object.values(CATALOG_FULL).find((p) => p.category === "salon/trolleys" && !p.is_component)!
        .name,
    );
    type Case = {
      id: string;
      mode: VisualizeMode;
      products: (typeof chair)[];
      note: string;
      anchor?: string;
      scene?: string;
      aspect?: string;
      room?: { wallCm: number; depthCm: number };
    };
    const cases: Case[] = [
      {
        id: "G01",
        mode: "staged_room",
        products: [
          { ...black, qty: 2 },
          { ...mirror, qty: 2 },
        ],
        note: "A spacious salon with exactly TWO black barber chairs side by side, each facing its own mirror. Wide camera view showing both chairs completely, daylight, neutral cream walls. No people.",
      },
      {
        id: "G02",
        mode: "staged_room",
        products: [
          { ...chair, qty: 4 },
          { ...mirror, qty: 4 },
        ],
        note: "Exactly four tan styling chairs and four matching round mirrors in a modern salon. All four stations visible, no people.",
      },
      {
        id: "G03",
        mode: "staged_room",
        products: [chair, mirror, desk, trolley],
        note: "A compact beige salon with one styling chair, one mirror, one reception desk and one trolley. Preserve actual product designs.",
        room: { wallCm: 400, depthCm: 600 },
      },
      {
        id: "G04",
        mode: "staged_room",
        products: [{ ...white, qty: 2 }, desk],
        note: "Two white styling chairs and one reception desk in a minimal Japandi salon with warm timber and plants.",
        aspect: "9:16",
      },
      {
        id: "G05",
        mode: "edit",
        products: [],
        anchor: "G01",
        note: "Change BOTH black barber chairs to WHITE upholstery. Both the left chair AND right chair must become white. Preserve their shape, chrome bases, count, positions, mirrors and room.",
      },
      {
        id: "G06",
        mode: "edit",
        products: [],
        anchor: "G01",
        note: "Change ONLY the LEFT black barber chair to white upholstery. Keep the RIGHT barber chair black. Preserve every other detail.",
      },
      {
        id: "G07",
        mode: "edit",
        products: [],
        anchor: "G01",
        note: "Paint the walls sage green. Keep both black barber chairs, mirror frames, floor and furniture exactly unchanged.",
      },
      {
        id: "G08",
        mode: "replace_all",
        products: [white],
        anchor: "G01",
        note: "Replace both black barber chairs with this white styling chair. Two chairs total, preserve both positions and the room.",
      },
      {
        id: "G09",
        mode: "replace",
        products: [chair],
        anchor: "G01",
        note: "Replace ONLY the RIGHT black barber chair with the tan styling chair. Keep the left black chair unchanged.",
      },
      {
        id: "G10",
        mode: "add",
        products: [trolley],
        anchor: "G01",
        note: "Add one trolley in the open foreground on the far right. Keep both existing black barber chairs and all mirrors.",
      },
      {
        id: "G11",
        mode: "lineup",
        products: [chair, white],
        anchor: "G01",
        note: "Show the tan chair on the LEFT and white chair on the RIGHT, one at each existing station. Preserve the architecture.",
      },
      {
        id: "G12",
        mode: "refit_room",
        products: [
          { ...white, qty: 2 },
          { ...mirror, qty: 2 },
        ],
        anchor: "G01",
        note: "Exactly two white styling chairs and two round mirrors. Keep the same room, camera and floor.",
      },
      {
        id: "G13",
        mode: "refit_room",
        products: [{ ...chair, qty: 2 }, { ...mirror, qty: 2 }, desk, trolley],
        anchor: "G01",
        note: "Two tan styling chairs, two round mirrors, one desk and one trolley. Keep original room architecture and all exits clear.",
      },
      {
        id: "G14",
        mode: "edit",
        products: [],
        anchor: "G02",
        note: "Change ALL FOUR tan chair seats and backrests to white upholstery. Keep exactly four chairs in the same places and do not change the mirrors.",
      },
      {
        id: "G15",
        mode: "edit",
        products: [],
        anchor: "G02",
        note: "Remove ONLY the far-right chair. Keep exactly three chairs, all four mirrors and the same room.",
      },
      {
        id: "G16",
        mode: "refit_room",
        products: [
          { ...white, qty: 4 },
          { ...mirror, qty: 4 },
        ],
        anchor: "G02",
        note: "Replace the styling area with exactly four white chairs and four round mirrors. Keep the same room and camera angle.",
      },
      {
        id: "G17",
        mode: "refit_room",
        products: [desk],
        anchor: "G03",
        scene: "reception area",
        note: "Update only the reception desk with the reference desk. Keep styling furniture unchanged.",
      },
      {
        id: "G18",
        mode: "edit",
        products: [],
        anchor: "G03",
        note: "Add one tall green potted plant in the left corner. Do not move or replace any furniture or change the floor.",
      },
      {
        id: "G19",
        mode: "lineup",
        products: [chair, white, black],
        anchor: "G02",
        note: "Show three DIFFERENT chair options left to right: tan styling, white styling, black barber. Keep the room architecture.",
      },
      {
        id: "G20",
        mode: "edit",
        products: [],
        anchor: "G04",
        note: "Change BOTH white styling chairs to black upholstery. Preserve the desk, warm timber, plants and portrait camera composition.",
      },
    ];
    const run = async (c: Case) => {
      let r = results.find((r) => r.id === c.id);
      if (r?.imageUrl || r?.error) return;
      const anchor = c.anchor ? sources.find((r: any) => r.id === c.anchor)?.imageUrl : null;
      if (c.anchor && !anchor) {
        results.push({
          ...c,
          products: c.products.map((p) => p.name),
          error: "Source generation unavailable; not submitted",
        });
        save();
        return;
      }
      const built = buildRenderRequest(c.products, c.mode, c.scene, undefined, c.room, c.note);
      built.prompt = whatsappImagePrompt(built.prompt, c.mode);
      if (!r) {
        r = {
          id: c.id,
          mode: c.mode,
          products: c.products.map((p) => ({ id: p.id, name: p.name, qty: p.qty ?? 1 })),
          note: c.note,
          anchor,
          referenceCount: built.imageUrls.length + (anchor ? 1 : 0),
          prompt: built.prompt,
          startedAt: new Date().toISOString(),
        };
        results.push(r);
        save();
      }
      try {
        if (!r.taskId) {
          r.taskId = await createVisualizeTask(
            anchor,
            built.imageUrls,
            built.prompt,
            c.aspect ?? "16:9",
            c.mode,
          );
          save();
          console.log(`${c.id} submitted with ${r.referenceCount} references`);
        }
        const deadline = Date.now() + 8 * 60 * 1000;
        while (Date.now() < deadline) {
          const status = await getTaskResult(r.taskId);
          if (status.done) {
            r.imageUrl = status.imageUrl;
            r.ms = Date.now() - Date.parse(r.startedAt);
            save();
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10000));
        }
        if (!r.imageUrl)
          throw new Error("No result within 8 minute observation window; task NOT resubmitted");
        const response = await fetch(r.imageUrl, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`Result download ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        writeFileSync(`${out}/${c.id}.png`, bytes);
        r.localPath = `${out}/${c.id}.png`;
        r.qa = anchor
          ? await inspectWhatsAppEdit(
              anchor,
              r.imageUrl,
              `${c.note}. Requested products: ${JSON.stringify(r.products)}. Preserve unrelated furniture and hardware.`,
            )
          : await runInspectRender({
              imageUrl: r.imageUrl,
              expected: c.products.map((p) => ({ name: p.name, qty: p.qty ?? 1 })),
            });
        console.log(`${c.id} completed ${Math.round(r.ms / 1000)}s; QA ${JSON.stringify(r.qa)}`);
      } catch (e) {
        r.error = String(e);
        console.log(`${c.id} ERROR ${r.error}`);
      }
      save();
    };
    // Reuse original synthetic rooms; only these three cases may buy generations.
    for (const c of cases.filter((c) => ["G05", "G15", "G17"].includes(c.id))) await run(c);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.imageUrl && (!r.error || r.lateResult))).toBe(true);
  },
  1_800_000,
);
