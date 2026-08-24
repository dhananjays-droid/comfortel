export type VisualizeProduct = {
  id: string;
  name: string;
  images: string[];
  specs?: Record<string, string> | null;
  dims_cm?: { w: number | null; d: number | null; h: number | null } | null;
  placement?: string | null;
  col?: string | null;
  colour?: string | null;
};

const PLACEMENT_CLAUSES: Record<string, string> = {
  floor: "Position it standing on the floor.",
  wall: "Mount it on a wall.",
  tabletop: "Place it on a table or surface.",
  ceiling: "Suspend it from the ceiling.",
  rug: "Lay it flat on the floor.",
};

/** Builds the image prompt from the catalog record, omitting clauses whose source field is null. */
export function buildPlacementPrompt(product: VisualizeProduct): string {
  const parts: string[] = [
    `Place this exact ${product.name} into the uploaded room photograph.`,
  ];

  const specs = product.specs ?? {};
  const material =
    product.col ||
    product.colour ||
    specs["Colour"] ||
    specs["Color"] ||
    specs["Material"] ||
    specs["Upholstery"] ||
    specs["Finish"];

  if (material) parts.push(`The product is ${material}.`);

  const d = product.dims_cm;
  if (d && (d.w || d.d || d.h)) {
    const measures = [
      d.w ? `${d.w}cm wide` : null,
      d.d ? `${d.d}cm deep` : null,
      d.h ? `${d.h}cm tall` : null,
    ].filter(Boolean);
    parts.push(
      `It measures approximately ${measures.join(", ").replace(/, ([^,]*)$/, " and $1")} — scale it accurately against the room.`,
    );
  }

  const placement = product.placement ? PLACEMENT_CLAUSES[product.placement] : undefined;
  if (placement) parts.push(placement);

  parts.push(
    "Match the perspective, lighting direction and colour temperature of the room.",
    "Cast a natural, soft shadow consistent with the existing light.",
    "Preserve the room's walls, flooring, windows and existing furniture exactly as they are.",
    "Photorealistic, natural, as if photographed in place.",
  );

  return parts.join(" ");
}
