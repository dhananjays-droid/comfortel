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

/** refit_room renders one image from several product references; the rest take one. */
export const MAX_REFERENCES = 4;

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
};

const PLACEMENT: Record<string, string> = {
  styling_chair: `Position it on the floor facing the mirror station, at the correct working distance a stylist would use.`,
  shampoo_unit: `Position it against the wall at the wash bay, with the basin oriented away from the wall.`,
  trolley: `Position it standing on the floor beside the styling station, within a stylist's arm's reach.`,
  mirror_unit: `Mount it flat against the wall at standard station height.`,
  reception: `Position it in the reception area, facing the entrance.`,
  dryer: `Position it on the floor beside a waiting chair, at seated head height.`,
  floor: `Position it standing flat on the salon floor.`,
};

/**
 * Removal is the instruction these models are most likely to soft-pedal: asked
 * to "replace" a chair they will often add the new one and leave the old one
 * standing next to it. So the removal is stated first, stated as its own step,
 * and restated as an acceptance check at the end — the two positions the model
 * weights most.
 */
function removalClauses(subject: string, all: boolean): string[] {
  if (all) {
    return [
      `Step 1 — REMOVE: delete every ${subject} currently in this salon from the image. Not one of them may remain.`,
      `Erase each one completely, including its base, hydraulic column, footrest and any castors, and rebuild the floor, skirting and wall behind where each stood so the space reads as empty and continuous.`,
    ];
  }
  return [
    `Step 1 — REMOVE: delete the existing ${subject} from this salon. It must be gone from the final image.`,
    `Erase it completely, including its base, hydraulic column, footrest and any castors, and rebuild the floor, skirting and wall behind it so the space reads as empty and continuous.`,
    `If more than one ${subject} is visible, remove only the one nearest the camera and leave the others exactly as they are.`,
  ];
}

/**
 * Shared closing requirements. Every mode needs the same physics — perspective,
 * lighting, mirror reflections, contact shadows — so they live in one place
 * rather than being restated per branch and drifting apart.
 */
function realismClauses(): string[] {
  return [
    `Critical realism requirements:`,
    `Match the salon's perspective, camera angle and floor plane exactly — every piece must sit flat on the floor with correct foreshortening, not float or tilt.`,
    `Match the salon's lighting direction, intensity and colour temperature, including the cool overhead lighting typical of salons.`,
    `If any mirror is visible and a placed piece falls within its line of sight, render a correct reflection of it in that mirror. A missing reflection is the most obvious sign of a fake composite.`,
    `Salon floors are often glossy tile or vinyl — render a soft reflection of each base on the floor, matching how existing furniture reflects.`,
    `Cast grounded contact shadows consistent with the room's existing shadows.`,
    `Photorealistic. The result should look like an unedited photograph of this salon with these products actually installed in it.`,
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
  const parts: string[] = [];
  const list = products.map((p, i) => `Image ${i + 2} is a ${describe(p)}`).join(". ");

  parts.push(
    `The first image is a photograph of a real hair salon. The images after it are Comfortel product references. ${list}.`,
    `Refit this salon with the Comfortel products shown.`,
    `Step 1 — REMOVE: strip out the salon's existing furniture — every styling chair, stool, trolley, mirror unit, reception desk and waiting seat that is visible. Remove each one completely, including bases, hydraulic columns and footrests.`,
    `Step 2 — INSTALL: fit the Comfortel pieces from the reference images into the room, putting each one where its type belongs — styling chairs at the mirror stations, mirrors on the wall above the benches, trolleys within arm's reach of a station, reception furniture by the entrance.`,
    `Where the salon had several of one type, repeat the matching Comfortel piece across all of those positions so the room reads as one coordinated fit-out, keeping the original spacing and orientation.`,
    `Reproduce each product exactly as shown in its reference image: shape, proportions, upholstery, stitching, base design and hardware finish must match precisely. Do not invent pieces that are not in the references, and do not restyle the ones that are.`,
    `Keep the room itself untouched: walls, flooring, ceiling, windows, plumbing, wash basins, lighting fixtures, signage, plants and any people stay exactly as they are. Only the furniture changes.`,
  );

  parts.push(...realismClauses());
  parts.push(
    `Before you finish, check the image: none of the salon's original furniture may still be present. Every visible piece is now a Comfortel product from the references.`,
  );
  return parts.join(" ");
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
  const parts: string[] = [];
  const subject = products[0]?.replaces ?? "unit";

  const assignments = products
    .map((p, i) => `Image ${i + 2} is a ${describe(p)} — put this one at position ${i + 1}`)
    .join(". ");

  parts.push(
    `The first image is a photograph of a real hair salon. The images after it are ${products.length} DIFFERENT Comfortel products.`,
    `Step 1 — REMOVE: delete the salon's existing ${subject}s from the image, all of them. Erase each one completely, including its base, hydraulic column, footrest and any castors, and rebuild the floor behind where each stood.`,
    `Step 2 — INSTALL: number the now-empty positions 1 to ${products.length} from left to right as the camera sees them. ${assignments}.`,
    `Each position gets a DIFFERENT product. Do not repeat one product across positions, and do not blend them into a single averaged design — the whole point is that the customer can see the difference between them side by side.`,
    `Reproduce each one exactly as shown in its own reference image: shape, proportions, upholstery colour, stitching, base design and hardware finish must match that specific reference and not the others.`,
    `If the salon has more positions than there are products, leave the extra positions empty. If it has fewer, place only as many products as there are positions, in the order given.`,
    `Keep the room itself untouched: walls, flooring, ceiling, windows, mirrors, wash basins, lighting fixtures, signage, plants and any people stay exactly as they are.`,
  );

  parts.push(...realismClauses());
  parts.push(
    `Before you finish, check the image: each position holds a visibly different product, matching its own reference, and none of the salon's original ${subject}s remain.`,
  );
  return parts.join(" ");
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

  const parts: string[] = [];
  const subject = product.replaces ?? "unit";
  const replacing = mode === "replace" || mode === "replace_all";
  const all = mode === "replace_all";

  parts.push(
    `The first image is a photograph of a real hair salon. The second image is a product reference showing a ${product.name}.`,
  );

  if (replacing) {
    parts.push(...removalClauses(subject, all));
    parts.push(
      all
        ? `Step 2 — INSTALL: put a ${product.name} from the reference image in each of those now-empty positions, matching the original spacing and orientation so the room reads as one matching set.`
        : `Step 2 — INSTALL: put the ${product.name} from the reference image in that now-empty position, standing where the old ${subject} stood.`,
    );
  } else {
    parts.push(
      `Place the ${product.name} from the reference image into the salon, in the clearest available floor space, without moving or removing anything that is already there.`,
    );
  }

  parts.push(
    `Reproduce the product exactly as shown in the reference: its shape, proportions, upholstery, stitching, base design and hardware finish must match precisely. Do not restyle it, do not simplify it and do not borrow the shape of the ${subject} you removed.`,
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
  if (material) parts.push(`It is finished in ${material}.`);

  const d = product.dims_cm;
  if (d?.w && d?.h) {
    parts.push(
      `It measures approximately ${d.w}cm wide and ${d.h}cm tall — scale it accurately against the salon's mirrors, counters and floor tiles.`,
    );
  } else if (d?.w) {
    parts.push(
      `It measures approximately ${d.w}cm wide — scale it accurately against the salon's mirrors, counters and floor tiles.`,
    );
  }

  const key = product.salon_placement || product.placement || "floor";
  if (PLACEMENT[key]) parts.push(PLACEMENT[key]);

  parts.push(...realismClauses());
  parts.push(
    `Preserve everything else in the salon exactly: walls, flooring, mirrors, wash basins, lighting fixtures, signage, product shelves, other furniture and any people. Change nothing except what these instructions specify.`,
  );

  if (replacing) {
    parts.push(
      all
        ? `Before you finish, check the image: no original ${subject} may still be present anywhere in the frame. Every one of them has been replaced by the ${product.name}.`
        : `Before you finish, check the image: the original ${subject} must not appear anywhere in the frame. The ${product.name} stands in its place — not beside it, not in addition to it.`,
    );
  }

  return parts.join(" ");
}
