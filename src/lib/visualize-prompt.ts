export type VisualizeMode = "replace" | "add";

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

/** Builds the salon placement prompt, omitting clauses whose source field is missing. */
export function buildSalonPrompt(product: VisualizeProduct, mode: VisualizeMode): string {
  const parts: string[] = [];

  const intro = `The first image is a photograph of a real hair salon. The second image is a product reference showing a ${product.name}.`;

  if (mode === "replace") {
    parts.push(
      intro,
      `Replace the existing ${product.replaces ?? "unit"} in the salon with the ${product.name} from the reference image.`,
      `Remove the old unit completely, including its base, and reconstruct the floor beneath it naturally.`,
    );
  } else {
    parts.push(
      intro,
      `Place the ${product.name} from the reference image into the salon, in the clearest available floor space.`,
    );
  }

  parts.push(
    `Reproduce the product exactly as shown in the reference: its shape, proportions, upholstery, stitching, base design and hardware finish must match precisely.`,
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
  }

  const key = product.salon_placement || product.placement || "floor";
  if (PLACEMENT[key]) parts.push(PLACEMENT[key]);

  parts.push(
    `Critical realism requirements:`,
    `Match the salon's perspective, camera angle and floor plane exactly — the product must sit flat on the floor with correct foreshortening, not float or tilt.`,
    `Match the salon's lighting direction, intensity and colour temperature, including the cool overhead lighting typical of salons.`,
    `If any mirror is visible and the product falls within its line of sight, render a correct reflection of the product in that mirror. A missing reflection is the most obvious sign of a fake composite.`,
    `Salon floors are often glossy tile or vinyl — render a soft reflection of the product's base on the floor, matching how existing furniture reflects.`,
    `Cast a grounded contact shadow consistent with the room's existing shadows.`,
    `Preserve everything else in the salon exactly: walls, flooring, mirrors, wash basins, lighting fixtures, signage, product shelves, other furniture and any people. Change nothing except the specified unit.`,
    `Photorealistic. The result should look like an unedited photograph of this salon with this product actually installed in it.`,
  );

  return parts.join(" ");
}
