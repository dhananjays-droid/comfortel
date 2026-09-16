import type { FullProduct } from "@/lib/catalog";
import { selectionProfile } from "@/lib/product-selection";

/** Derived from saved catalog evidence, not generated specifications. */
export function productFit(p: FullProduct) {
  const profile = selectionProfile(p);
  const island = profile.mirrorLayout === "island";
  const workSurface = profile.features.workSurface === true;
  return {
    source: profile.evidenceStatus,
    mirrorLayout: island ? "island" : "wall-assumed",
    stationFaces: profile.stationFaces,
    workSurface,
    installationCheckRequired: true,
    reason:
      profile.mounting === "wall_or_rear_support"
        ? "This single station needs wall or rear support; it is not a self-supporting island. Confirm dimensions and support before installation."
        : island
          ? "Island/pole-mounted design: confirm floor/ceiling fixing and circulation space."
          : workSurface
            ? "Catalog describes a work surface for station tools; confirm wall fixing and dimensions."
            : "Confirm mounting and a separate tool work surface before installation.",
  };
}
