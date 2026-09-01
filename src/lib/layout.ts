import type { Dims } from "@/lib/dims";

/**
 * Salon layout geometry.
 *
 * This is the "code decides placement, the model only draws it" half of the
 * design engine. Everything here is arithmetic on real product dimensions, so a
 * plan can be inspected, costed, corrected and re-rendered — none of which is
 * possible when the arrangement only exists inside a finished image.
 *
 * IMPORTANT — these clearances are trade convention, not regulation. They are
 * the assumptions this tool plans with, they are stated in the output so a
 * customer can disagree with them, and they are all in one place so they can be
 * tuned. Do not present them to a customer as code compliance or as advice about
 * accessibility requirements, which vary by jurisdiction.
 */
export const CLEARANCE = {
  /** Gap between neighbouring styling chairs so two stylists can work at once. */
  betweenStations: 30,
  /** Gap from the end of a wall run to the first chair. */
  wallEnd: 15,
  /** Clear floor a stylist needs to walk and work behind a chair. */
  circulation: 100,
  /** A backwash needs plumbing depth behind the basin. */
  behindBackwash: 20,
} as const;

/** Fallback footprints, used only when a product has no measured dimension. */
export const ASSUMED = {
  stationWidth: 60,
  stationDepth: 60,
} as const;

export type StationFit = {
  /** How many stations fit along the run. */
  count: number;
  /** Centre-to-centre spacing actually used, in cm. */
  pitch: number;
  /** Wall length the plan consumes, in cm. */
  used: number;
  /** Spare wall left over, in cm. */
  spare: number;
};

/**
 * How many stations fit along a wall.
 *
 * Pitch is the chair's own width plus the gap between neighbours. The wall-end
 * clearance is charged once at each end, not per station, which is why this is
 * not a plain division.
 */
export function stationsAlongWall(wallCm: number, chairWidthCm: number): StationFit {
  const width = chairWidthCm > 0 ? chairWidthCm : ASSUMED.stationWidth;
  const pitch = width + CLEARANCE.betweenStations;
  const usable = wallCm - CLEARANCE.wallEnd * 2;

  if (usable < width) {
    return { count: 0, pitch, used: 0, spare: Math.max(0, wallCm) };
  }

  // n chairs need n widths plus (n-1) gaps.
  const count = Math.floor((usable + CLEARANCE.betweenStations) / pitch);
  const used = count * width + (count - 1) * CLEARANCE.betweenStations;
  return { count, pitch, used, spare: Math.max(0, wallCm - used - CLEARANCE.wallEnd * 2) };
}

/**
 * The wall a given number of stations needs. The inverse of stationsAlongWall,
 * for answering "four won't fit, here is what four would take".
 */
export function wallForStations(count: number, chairWidthCm: number): number {
  if (count <= 0) return 0;
  const width = chairWidthCm > 0 ? chairWidthCm : ASSUMED.stationWidth;
  return count * width + (count - 1) * CLEARANCE.betweenStations + CLEARANCE.wallEnd * 2;
}

export type DepthCheck = { fits: boolean; needed: number; short: number };

/**
 * Whether the room is deep enough for a run of stations plus a walkway.
 *
 * A chair against a wall is not the whole story — someone has to stand behind
 * it, and on a reclining chair the extended length is what actually matters.
 */
export function depthFits(roomDepthCm: number, itemDepthCm: number): DepthCheck {
  const depth = itemDepthCm > 0 ? itemDepthCm : ASSUMED.stationDepth;
  const needed = depth + CLEARANCE.circulation;
  return {
    fits: roomDepthCm >= needed,
    needed,
    short: Math.max(0, needed - roomDepthCm),
  };
}

export type Room = {
  /** Length of the wall the stations run along, in cm. */
  wallCm: number;
  /** Depth of the room away from that wall, in cm. Optional. */
  depthCm?: number | undefined;
  /**
   * How confident we are in those numbers. A photo-derived estimate must not
   * produce a flat "this does not fit" — see `capacity`.
   */
  confidence: "measured" | "estimated";
};

export type Capacity = {
  fits: number;
  requested?: number | undefined;
  pitch: number;
  warnings: string[];
  /** True when the numbers came from an estimate and should be hedged. */
  hedged: boolean;
};

/**
 * How many stations this room takes, and what to say about it.
 *
 * The warnings are the product, not a side effect: a tool that silently plans
 * three chairs when the customer asked for four is worse than one that explains
 * why. When the room came from a photo estimate the language stays hedged, never
 * a flat refusal, because the estimate carries real error.
 */
export function capacity(
  room: Room,
  chair: Dims,
  requested?: number,
  /**
   * How to render a length. Defaults to metres; callers who know the customer
   * typed feet pass a foot formatter, so the warning answers in the unit the
   * question was asked in rather than silently switching.
   */
  format: (cm: number) => string = (cm) => `${(cm / 100).toFixed(1)}m`,
): Capacity {
  const fit = stationsAlongWall(room.wallCm, chair.w ?? 0);
  const hedged = room.confidence === "estimated";
  const warnings: string[] = [];

  const m = format;

  if (fit.count === 0) {
    warnings.push(
      hedged
        ? `That wall reads as about ${m(room.wallCm)}, which looks too short for even one station at ${m(fit.pitch)} spacing.`
        : `A ${m(room.wallCm)} wall is too short for a station at ${m(fit.pitch)} spacing.`,
    );
  }

  if (requested && requested > fit.count) {
    const needed = wallForStations(requested, chair.w ?? 0);
    warnings.push(
      hedged
        ? `${requested} stations need about ${m(needed)} of wall. Yours reads as roughly ${m(room.wallCm)}, so ${requested} will be tight and ${fit.count} is comfortable.`
        : `${requested} stations need ${m(needed)} of wall and you have ${m(room.wallCm)}, so ${fit.count} fit.`,
    );
  }

  if (room.depthCm) {
    const depth = depthFits(room.depthCm, chair.d ?? 0);
    if (!depth.fits) {
      warnings.push(
        hedged
          ? `Depth looks tight: this piece plus a walkway wants about ${m(depth.needed)} and the room reads as ${m(room.depthCm)}.`
          : `This piece plus a walkway needs ${m(depth.needed)} of depth and the room has ${m(room.depthCm)}.`,
      );
    }
  }

  if (!chair.w) {
    warnings.push(
      `No measured width for this piece, so the plan assumes ${ASSUMED.stationWidth}cm.`,
    );
  }

  return {
    fits: fit.count,
    requested,
    pitch: fit.pitch,
    warnings,
    hedged,
  };
}
