export type VisualizeMode = "replace" | "replace_all" | "add" | "refit_room" | "lineup";

export const VISUALIZE_MODES: VisualizeMode[] = [
  "replace",
  "replace_all",
  "add",
  "refit_room",
  "lineup",
];

/** Modes that render ONE image from several product references. */
export const MULTI_REFERENCE_MODES: VisualizeMode[] = ["refit_room", "lineup"];

export function isMultiReferenceMode(mode: VisualizeMode): boolean {
  return MULTI_REFERENCE_MODES.includes(mode);
}

/**
 * How many DIFFERENT products one render may contain.
 *
 * GPT Image 2 accepts 16 input images, and the room takes one, so the API
 * allows 15. Ten is the product cap because the binding limit is not the API,
 * it is fidelity: each additional product in a frame gets fewer pixels and the
 * silhouettes start converging. Past roughly six the individual pieces stop
 * being recognisable, so the UI warns beyond RECOMMENDED_REFERENCES and a
 * zone-split is the better answer for a big plan.
 */
export const MAX_REFERENCES = 10;

/** Above this, per-product fidelity is visibly worse. The UI says so. */
export const RECOMMENDED_REFERENCES = 6;

/**
 * Past its prompt limit kie rejects createTask outright with "The text length
 * cannot exceed the maximum limit". The failure is total — no task, no credits
 * spent, the customer just sees the render fail — so every prompt this module
 * returns goes through assemble() and cannot exceed it by adding a clause here.
 *
 * gpt-image/1.5 capped this at exactly 3000 characters (measured: 3000 accepted,
 * 3001 rejected), which is what silently broke every replace render once the
 * fidelity clauses pushed the prompt to 3080. GPT Image 2 documents 20000; 6000
 * is what has been verified against the live API, and the longest prompt built
 * here is under 3000 anyway, so this is headroom rather than a target — long
 * prompts also dilute instruction-following.
 */
export const MAX_PROMPT_CHARS = 6000;

/**
 * How many views of ONE product to send on the single-product modes.
 *
 * A single hero shot means the model never sees the armrest profile or the base
 * and invents both — the two things a buyer recognises a chair by. Four covers
 * hero + front + side + back, every distinct angle the catalogue actually has;
 * GPT Image 2 accepts up to 16 images, so this is bounded by the photography
 * rather than by the API.
 *
 * NOT env-driven: this module is imported by visualize.functions.ts, whose
 * validator runs in the browser too, so `process.env` here would throw
 * "process is not defined" at import time in the client bundle.
 */
export const MAX_VIEWS = 4;

/**
 * `drop` is the order clauses are sacrificed in when the budget is tight:
 * lowest first, 0 meaning never. It is an explicit rank rather than "drop from
 * the end" because the least valuable clause is not the last one — the closing
 * acceptance check earns its place, the dimension hint does not.
 */
type Clause = { text: string; drop: number };

/** Sacrifice order, least valuable first. */
const DROP = {
  /** Scale hint — the unit being removed already sets the scale. */
  size: 1,
  /** Where it goes — restates what the room already makes obvious. */
  position: 2,
  /** Reflections and shadows — the render usually gets these right unprompted. */
  polish: 3,
  /** Any other elaboration on an instruction already given. */
  detail: 4,
} as const;

const req = (text: string): Clause => ({ text, drop: 0 });
const opt = (text: string, drop: number = DROP.detail): Clause => ({ text, drop });

/**
 * Join clauses within MAX_PROMPT_CHARS.
 *
 * Over budget, whole clauses are dropped in `drop` order — every optional
 * clause here elaborates on an instruction already given, so losing one costs
 * some fidelity but nothing essential. Truncating mid-sentence instead would
 * hand the model a dangling instruction, which is worse than not sending it.
 */
function assemble(clauses: Clause[]): string {
  const joined = (list: Clause[]) => list.map((c) => c.text).join(" ");

  const kept = [...clauses];
  while (joined(kept).length > MAX_PROMPT_CHARS) {
    // Lowest rank goes first; among equals, the later one.
    let victim = -1;
    for (let i = 0; i < kept.length; i++) {
      const d = kept[i]?.drop ?? 0;
      if (d === 0) continue;
      if (victim < 0 || d <= (kept[victim]?.drop ?? 0)) victim = i;
    }
    if (victim < 0) break;
    kept.splice(victim, 1);
  }

  const out = joined(kept);
  if (out.length <= MAX_PROMPT_CHARS) return out;

  // Required clauses alone should never blow the budget. If they ever do, a
  // shortened prompt still renders; a rejected request does not.
  const cut = out.slice(0, MAX_PROMPT_CHARS);
  const lastStop = cut.lastIndexOf(". ");
  return lastStop > 0 ? cut.slice(0, lastStop + 1) : cut;
}

/**
 * Mirrors ANGLE_PHRASE in product-views.ts. Duplicated on purpose: that module
 * imports JSON and this one is reachable from the client bundle, which must not
 * pull the data in. product-views.test.ts asserts the two stay in step.
 *
 * Typed by the literal union rather than `string`: this repo has
 * noUncheckedIndexedAccess, so a string-keyed record would make every lookup
 * `string | undefined`.
 */
type ViewAngleName = "hero" | "front" | "side" | "back" | "detail";

const ANGLE_PHRASES: Record<ViewAngleName, string> = {
  hero: "as the catalogue shows it",
  front: "from the front",
  side: "from the side",
  back: "from the back",
  detail: "in close-up detail",
};

const VIEW_ORDER: Array<[RegExp, string]> = [
  [/front/i, "from the front"],
  [/side/i, "from the side"],
  [/back/i, "from the back"],
];

/**
 * Ordered, de-duplicated views of one product: the hero shot first, then any
 * explicit front/side/back photograph.
 *
 * Lifestyle shots are skipped deliberately — a photo of the chair already
 * standing in someone else's salon competes with "the first image is the salon"
 * and confuses which room is being edited.
 */
export function referenceViews(
  product: VisualizeProduct,
  max = MAX_VIEWS,
): Array<{ url: string; angle: string }> {
  // Classified data wins: it knows which photos are the same physical product,
  // which a filename cannot. The classifier already orders these hero-first.
  if (product.views?.length) {
    return product.views.slice(0, max).map((v) => ({
      url: v.url,
      angle: ANGLE_PHRASES[v.angle],
    }));
  }

  const images = product.images ?? [];
  const out: Array<{ url: string; angle: string }> = [];
  const seen = new Set<string>();

  const push = (url: string | undefined, angle: string) => {
    if (!url || seen.has(url) || out.length >= max) return;
    seen.add(url);
    out.push({ url, angle });
  };

  push(images[0], "as the catalogue shows it");
  for (const [pattern, angle] of VIEW_ORDER) {
    push(
      images.find((u) => pattern.test(u) && !/salon-chair-\d|lifestyle|interior/i.test(u)),
      angle,
    );
  }
  return out;
}

export function isVisualizeMode(value: unknown): value is VisualizeMode {
  return typeof value === "string" && (VISUALIZE_MODES as string[]).includes(value);
}

export type VisualizeProduct = {
  id: string;
  name: string;
  images: string[];
  specs?: Record<string, string> | null;
  dims_cm?: { w: number | null; d: number | null; h: number | null } | null;
  placement?: string | null;
  salon_placement?: string | null;
  replaces?: string | null;
  col?: string | null;
  colour?: string | null;
  /**
   * Verified reference views, attached by the caller from product-views.json.
   * Optional so this module stays free of data imports — it is reachable from
   * the client bundle.
   */
  views?: Array<{ url: string; angle: ViewAngleName }> | undefined;
};

const PLACEMENT: Record<string, string> = {
  styling_chair: `Position it facing the mirror station at a stylist's working distance.`,
  shampoo_unit: `Position it against the wall at the wash bay, basin oriented away from the wall.`,
  trolley: `Position it beside the styling station, within a stylist's arm's reach.`,
  mirror_unit: `Mount it flat against the wall at standard station height.`,
  reception: `Position it in the reception area, facing the entrance.`,
  dryer: `Position it beside a waiting chair, at seated head height.`,
  floor: `Position it standing flat on the salon floor.`,
};

/**
 * Mirrors are the single most-reported remaining fault, and the cause was an
 * omission: the removal step told the model to rebuild "the floor, skirting and
 * wall behind" each unit and never mentioned reflections, while the realism
 * clause only asked it to ADD a reflection of the new piece. So the old chair
 * was deleted from the room and left standing in every mirror.
 *
 * A salon is the worst case for this — a wall of mirrors means most of the
 * furniture appears twice, and half of those copies were going unedited.
 */
const MIRROR_REMOVAL = (subject: string, product: string, all: boolean): string =>
  all
    ? `Mirrors count as positions too. Every mirror reflects the salon, so each ${subject} appears more than once — once as itself and again in every mirror that can see it. Treat each reflected ${subject} as ANOTHER ONE TO REPLACE, not as something to erase: when you are done, each reflection shows the new ${product}, exactly as the floor does. Two failures to avoid — a mirror still showing an old ${subject}, and a mirror emptied of a chair that is still standing in front of it. Both are failed renders.`
    : `Each mirror must agree with whatever now stands in front of it: a mirror facing the replaced ${subject} shows the new ${product}, and a mirror facing one you left alone still shows that original.`;

/**
 * Removal is the instruction these models are most likely to soft-pedal: asked
 * to "replace" a chair they will often add the new one and leave the old one
 * standing next to it. So the removal is stated first, stated as its own step,
 * and restated as an acceptance check at the end — the two positions the model
 * weights most.
 */
function removalClauses(subject: string, product: string, all: boolean): Clause[] {
  if (all) {
    return [
      req(
        `Step 1 — REMOVE: delete every ${subject} in this salon; not one may remain. Erase each completely — base, hydraulic column, footrest and castors — and rebuild the floor, skirting and wall behind where each stood.`,
      ),
      req(MIRROR_REMOVAL(subject, product, true)),
    ];
  }
  return [
    req(
      `Step 1 — REMOVE: delete the existing ${subject} from this salon; it must be gone from the final image. Erase it completely — base, hydraulic column, footrest and castors — and rebuild the floor, skirting and wall behind it.`,
    ),
    req(MIRROR_REMOVAL(subject, product, false)),
    // Scope, stated as a hard count. This was a droppable one-liner buried
    // mid-prompt, and it did not hold: given several reference views of the new
    // product, two of two renders broke it — one replaced every chair in the
    // room, the other deleted the ones it was told to leave. More references
    // appear to crowd out the scope instruction, so it is now required, phrased
    // as a count, and restated in the closing check.
    // Deliberately one plain sentence. Prose scoping was tried four times with
    // escalating specificity — "nearest the camera", a hard count, mirror-scope
    // rules, a spatial FOREGROUND anchor — and produced four different wrong
    // outcomes: all chairs replaced, the others deleted, the wrong chair
    // targeted, reflections left stale. The model cannot track one instance
    // among identical units, and the fix for that is a mask, which this vendor
    // does not expose. So single-replace is best-effort and `replace_all` is the
    // default; see GUIDE.md.
    req(
      `Change only the ${subject} closest to the camera. Leave every other ${subject} in the room exactly as it is.`,
    ),
  ];
}

/**
 * Shared closing requirements. Every mode needs the same physics — perspective,
 * lighting, mirror reflections, contact shadows — so they live in one place
 * rather than being restated per branch and drifting apart.
 */
function realismClauses(): Clause[] {
  return [
    req(
      `Critical realism: match the salon's perspective, camera angle and floor plane exactly — every piece sits flat on the floor with correct foreshortening, never floating or tilted.`,
    ),
    req(`Match the salon's lighting direction, intensity and colour temperature.`),
    // Clearing stale reflections works and is kept. Making the model DRAW a
    // reflection of the inserted piece does not: two escalating instructions
    // were tested live — "show that piece from the angle that mirror sees" and
    // an explicit "a mirror shows the OPPOSITE side to the camera" geometry
    // rule — and both were ignored, leaving the mirrors simply empty. These
    // models duplicate rather than reflect; they have no mirror geometry to
    // instruct. Prompt text that demonstrably does nothing is dead weight, so
    // only the clause that measurably changes the output stays.
    req(
      `No mirror may still show anything that was removed. A mirror must not reflect a piece that is no longer in the room.`,
    ),
    opt(
      `Add a soft floor reflection of each base and contact shadows consistent with the room's existing ones.`,
      DROP.polish,
    ),
    req(
      `Photorealistic — an unedited photograph of this salon with these products actually installed.`,
    ),
  ];
}

function describe(product: VisualizeProduct): string {
  const specs = product.specs ?? {};
  const material =
    product.col ||
    product.colour ||
    specs["Material"] ||
    specs["Upholstery"] ||
    specs["Finish"] ||
    specs["Colour"] ||
    specs["Color"];
  return material ? `${product.name}, finished in ${material}` : product.name;
}

/**
 * Whole-room refit: one render, several product references. The customer is
 * asking "what would my salon look like kitted out in Comfortel", so the
 * architecture is preserved and the furniture is swapped wholesale.
 */
function buildRefitPrompt(products: VisualizeProduct[]): string {
  const list = products.map((p, i) => `Image ${i + 2} is a ${describe(p)}`).join(". ");

  return assemble([
    req(
      `The first image is a photograph of a real hair salon. The images after it are Comfortel product references. ${list}.`,
    ),
    req(`Refit this salon with the Comfortel products shown.`),
    req(
      `Step 1 — REMOVE: strip out the salon's existing furniture — every styling chair, stool, trolley, mirror unit, reception desk and waiting seat visible. Remove each completely, including bases, hydraulic columns and footrests.`,
    ),
    req(
      `Step 2 — INSTALL: fit the Comfortel pieces into the room, each where its type belongs — styling chairs at the mirror stations, mirrors on the wall above the benches, trolleys within arm's reach of a station, reception furniture by the entrance.`,
    ),
    opt(
      `Where the salon had several of one type, repeat the matching Comfortel piece across all of those positions so the room reads as one coordinated fit-out, keeping the original spacing and orientation.`,
    ),
    req(
      `Reproduce each product exactly as its reference shows it: shape, proportions, upholstery, stitching, base design and hardware finish. Do not invent pieces that are not in the references, and do not restyle the ones that are.`,
    ),
    req(
      `Keep the room itself untouched: walls, flooring, ceiling, windows, plumbing, wash basins, lighting, signage, plants and any people stay exactly as they are. Only the furniture changes.`,
    ),
    ...realismClauses(),
    req(
      `Before you finish, check: none of the salon's original furniture is still present, and every visible piece is a Comfortel product from the references.`,
    ),
  ]);
}

/**
 * Several DIFFERENT products in one image, one per station, left to right.
 *
 * This is the cheap answer to "show me a few chairs in my space": one render
 * instead of one per product. It is NOT a substitute for a true A/B — that
 * needs the same position occupied by each candidate in turn, which is a
 * separate image every time. Here the customer sees every design in situ at
 * once, for a quarter of the cost, and gives up like-for-like positioning.
 */
function buildLineupPrompt(products: VisualizeProduct[]): string {
  const subject = products[0]?.replaces ?? "unit";
  const assignments = products
    .map((p, i) => `Image ${i + 2} is a ${describe(p)} — put this one at position ${i + 1}`)
    .join(". ");

  return assemble([
    req(
      `The first image is a photograph of a real hair salon. The images after it are ${products.length} DIFFERENT Comfortel products.`,
    ),
    req(
      `Step 1 — REMOVE: delete the salon's existing ${subject}s, all of them. Erase each completely — base, hydraulic column, footrest and castors — and rebuild the floor behind where each stood.`,
    ),
    req(
      `Step 2 — INSTALL: number the now-empty positions 1 to ${products.length} from left to right as the camera sees them. ${assignments}.`,
    ),
    req(
      `Each position gets a DIFFERENT product. Do not repeat one across positions and do not blend them into a single averaged design — the point is that the customer can see the difference side by side.`,
    ),
    req(
      `Reproduce each one exactly as its own reference shows it: shape, proportions, upholstery colour, stitching, base design and hardware finish must match that specific reference and not the others.`,
    ),
    opt(
      `If the salon has more positions than there are products, leave the extra positions empty. If fewer, place only as many products as there are positions, in the order given.`,
    ),
    req(
      `Keep the room itself untouched: walls, flooring, ceiling, windows, mirrors, wash basins, lighting, signage, plants and any people stay exactly as they are.`,
    ),
    ...realismClauses(),
    req(
      `Before you finish, check: each position holds a visibly different product matching its own reference, and none of the salon's original ${subject}s remain.`,
    ),
  ]);
}

/**
 * Builds the salon placement prompt, omitting clauses whose source field is
 * missing. Takes a list because refit_room and lineup render one image from
 * several product references; the other modes use the first entry only.
 */
export function buildSalonPrompt(products: VisualizeProduct[], mode: VisualizeMode): string {
  if (mode === "refit_room") return buildRefitPrompt(products.slice(0, MAX_REFERENCES));
  if (mode === "lineup") return buildLineupPrompt(products.slice(0, MAX_REFERENCES));

  const product = products[0];
  if (!product) throw new Error("buildSalonPrompt needs at least one product");

  const clauses: Clause[] = [];
  const subject = product.replaces ?? "unit";
  const replacing = mode === "replace" || mode === "replace_all";
  const all = mode === "replace_all";

  const views = referenceViews(product);
  const viewList = views.map((v, i) => `image ${i + 2} shows it ${v.angle}`).join(", ");
  clauses.push(
    req(
      views.length > 1
        ? `The first image is a photograph of a real hair salon. The ${views.length} images after it are ALL the same product — a ${product.name} — photographed from different angles: ${viewList}. Study every one before you draw it.`
        : `The first image is a photograph of a real hair salon. The second image is a product reference showing a ${product.name}.`,
    ),
  );

  if (replacing) {
    clauses.push(...removalClauses(subject, product.name, all));
    clauses.push(
      req(
        all
          ? `Step 2 — INSTALL: put a ${product.name} in every one of those now-empty positions, keeping the count exactly as it was — four ${subject}s before means four after, none added and none dropped.`
          : `Step 2 — INSTALL: put the ${product.name} from the reference in that now-empty position, standing where the old ${subject} stood.`,
      ),
    );
    if (all) {
      clauses.push(
        req(
          `Keep each station's original position, spacing and FACING — one angled towards the camera stays so, one seen from behind stays so — drawing the product from whichever angle that station needs.`,
        ),
        // Reported fault: the copies drifted. Pinning count and facing said
        // nothing about the instances matching EACH OTHER, so the model treated
        // each position as a fresh interpretation of the references.
        req(
          `Every ${product.name} you place is the same single model and must be identical to the others: same silhouette, same armrests, same base, same seams, same finish. Two chairs in this room differing in design is a failed render. Between positions they may differ ONLY in size, angle and position, as perspective requires.`,
        ),
      );
    }
  } else {
    clauses.push(
      req(
        `Place the ${product.name} from the reference into the salon, in the clearest available floor space, without moving or removing anything already there.`,
      ),
    );
  }

  // The single most-reported failure: the room is right, the chair is a
  // generic stand-in. The armrest profile and the base are what a buyer
  // recognises a model by, so they are called out individually.
  clauses.push(
    req(
      `COPY THE PRODUCT EXACTLY — the most important requirement here. A beautiful room containing the wrong chair is a failed render.`,
    ),
    // The dominant observed failure is not a generic chair: it is the model
    // RE-UPHOLSTERING what is already there. Asked to fit a black chair it
    // recolours the existing chrome one black and keeps its frame, base and
    // footrest. Naming that specific outcome as a failure is what stops it.
    req(
      `Do NOT recolour, reupholster or restyle what is already in the room. Re-covering the existing ${subject} in the reference's colour while keeping its frame, base, footrest or headrest is a FAILED render. Delete the old one and build the ${product.name} from scratch in its place.`,
    ),
    req(
      `Match every detail of the reference: the silhouette of the back and seat, the exact profile and thickness of the ARMRESTS, the upholstery seams and stitching, and the BASE — its shape, its legs or its disc, its column and its footrest.`,
    ),
    req(
      `Armrests and base are most often got wrong: reproduce what is actually there. Do not square off curved arms, curve square arms, or swap a star base for a disc base.`,
    ),
    req(
      `Do not substitute a generic salon chair and do not borrow any part of the ${subject} you removed — that is a different model.`,
    ),
    req(
      `Only the size, angle and position of the piece may differ from the reference images. Every other aspect of its design — proportions, armrests, base, seams, hardware and finish — must match them exactly.`,
    ),
  );

  const specs = product.specs ?? {};
  const material =
    product.col ||
    product.colour ||
    specs["Material"] ||
    specs["Upholstery"] ||
    specs["Finish"] ||
    specs["Colour"] ||
    specs["Color"];
  if (material) clauses.push(req(`It is finished in ${material}.`));

  const d = product.dims_cm;
  const size = d?.w && d?.h ? `${d.w}cm wide and ${d.h}cm tall` : d?.w ? `${d.w}cm wide` : null;
  if (size) {
    clauses.push(
      opt(
        `It measures approximately ${size} — scale it accurately against the salon's mirrors, counters and floor tiles.`,
        DROP.size,
      ),
    );
  }

  // Only meaningful for `add`: on a replace, the position is already fixed by
  // whatever is being removed, so this would just spend budget restating it.
  if (!replacing) {
    const placementKey = product.salon_placement || product.placement || "floor";
    const placement = PLACEMENT[placementKey];
    if (placement) clauses.push(opt(placement, DROP.position));
  }

  clauses.push(...realismClauses());
  clauses.push(
    opt(
      `Preserve everything else exactly: walls, flooring, mirrors, wash basins, lighting, signage, shelves, other furniture and any people.`,
    ),
  );

  if (replacing) {
    clauses.push(
      req(
        all
          ? `Before you finish, check three things. One: no original ${subject} remains anywhere in the frame INCLUDING inside every mirror, and the count is unchanged. Two: every one is unmistakably the ${product.name} — same arms, same base, same seams — not a recoloured version of the old one. Three: all of them are identical to each other, and each mirror reflects what is actually in front of it.`
          : `Before you finish, check: the ${subject} you replaced is gone and the ${product.name} stands in its place, not beside it; every other ${subject} is untouched; and each mirror matches what is in front of it.`,
      ),
    );
  }

  return assemble(clauses);
}

/**
 * The prompt and the image array in one call, deliberately.
 *
 * The prompt refers to its references positionally ("image 2 shows it from the
 * front"), so the two have to be built from the same decision. Returning them
 * separately invited exactly one bug: the prompt claiming a view the array
 * didn't contain.
 */
export function buildRenderRequest(
  products: VisualizeProduct[],
  mode: VisualizeMode,
): { prompt: string; imageUrls: string[] } {
  const prompt = buildSalonPrompt(products, mode);

  const imageUrls = isMultiReferenceMode(mode)
    ? // one hero shot per DIFFERENT product
      products
        .slice(0, MAX_REFERENCES)
        .map((p) => p.images?.[0])
        .filter((u): u is string => Boolean(u))
    : // several views of THE SAME product
      referenceViews(products[0] as VisualizeProduct).map((v) => v.url);

  return { prompt, imageUrls };
}
