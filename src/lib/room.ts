import { ASSUMED, CLEARANCE, capacity, type Capacity, type Room } from "@/lib/layout";

/**
 * The room the customer is fitting out, as they described it.
 *
 * This is the front half of the "code decides placement, the model only draws
 * it" split: the customer gives dimensions, `layout.ts` does the arithmetic, and
 * the model is handed a finished answer to talk about rather than numbers to
 * work out. Language models are unreliable at exactly this kind of sums, and a
 * wrong station count is the one error a salon owner would actually act on.
 */

/** Salon owners in the US think in feet; the catalogue is measured in cm. */
export type Unit = "m" | "ft";

const CM_PER = { m: 100, ft: 30.48 } as const;

/** A run of wall shorter than this is a measurement slip, not a small salon. */
export const MIN_WALL_CM = 100;
/** Beyond this it is a warehouse, and almost certainly a units mistake. */
export const MAX_WALL_CM = 3000;

export function toCm(value: number, unit: Unit): number {
  return value * CM_PER[unit];
}

export function fromCm(cm: number, unit: Unit): number {
  return cm / CM_PER[unit];
}

/**
 * One decimal is the honest precision for a number someone paced or eyeballed,
 * but a whole number should read as one — "a 16 ft wall", not "a 16.0 ft wall".
 */
export function formatLength(cm: number, unit: Unit): string {
  const value = fromCm(cm, unit).toFixed(1);
  return `${value.endsWith(".0") ? value.slice(0, -2) : value} ${unit}`;
}

export type RoomSpec = {
  /** The wall the styling stations run along. */
  wallCm: number;
  /** Depth away from that wall. Optional — plenty of people only know one. */
  depthCm?: number | undefined;
  /** How many stations they want, if they have a number in mind. */
  stations?: number | undefined;
  /** The unit they typed in, so we answer in the same one. */
  unit: Unit;
};

export type ValidationError = { field: "wall" | "depth" | "stations"; message: string };

/**
 * Catches the mistakes worth catching — a units slip and an empty wall — without
 * turning a rough estimate into a form fight. Depth and station count are
 * genuinely optional.
 */
export function validate(spec: Partial<RoomSpec> & { unit: Unit }): ValidationError[] {
  const errors: ValidationError[] = [];
  const { wallCm, depthCm, stations, unit } = spec;

  if (!wallCm || wallCm <= 0) {
    errors.push({ field: "wall", message: "Add the length of your styling wall." });
  } else if (wallCm < MIN_WALL_CM) {
    errors.push({
      field: "wall",
      message: `That is under ${formatLength(MIN_WALL_CM, unit)} — check the units.`,
    });
  } else if (wallCm > MAX_WALL_CM) {
    errors.push({
      field: "wall",
      message: `That is over ${formatLength(MAX_WALL_CM, unit)} — check the units.`,
    });
  }

  if (depthCm !== undefined && depthCm > 0 && depthCm > MAX_WALL_CM) {
    errors.push({ field: "depth", message: "That depth looks like a units mistake." });
  }

  if (stations !== undefined && (stations < 1 || stations > 20)) {
    errors.push({ field: "stations", message: "Between 1 and 20 stations." });
  }

  return errors;
}

/**
 * A typed room becomes a measured one — the customer gave us real numbers, so
 * `capacity` is allowed to answer plainly instead of hedging the way it must for
 * a figure estimated off a photo.
 */
export function toRoom(spec: RoomSpec): Room {
  return {
    wallCm: spec.wallCm,
    ...(spec.depthCm ? { depthCm: spec.depthCm } : {}),
    confidence: "measured",
  };
}

/**
 * Capacity for a room before any product is chosen.
 *
 * Passes the assumed station footprint explicitly rather than leaving it blank,
 * because `capacity` would otherwise warn about "this piece" having no measured
 * width — which reads as nonsense when no piece has been picked yet. The
 * assumption is stated in the summary instead, where it belongs.
 */
export function genericCapacity(spec: RoomSpec): Capacity {
  // Height plays no part in a floor plan, but Dims requires all three.
  return capacity(
    toRoom(spec),
    { w: ASSUMED.stationWidth, d: ASSUMED.stationDepth, h: null },
    spec.stations,
    // Answer in the unit they typed. Telling someone who works in feet that
    // they need "7.2m of wall" makes them do the conversion we exist to avoid.
    (cm) => formatLength(cm, spec.unit),
  );
}

/**
 * What the customer's message says.
 *
 * The arithmetic is already done here, so the model's only job is to pick
 * products that suit it. Keeping the numbers in the message text — rather than
 * in some side channel — means they survive into the replayed history, so the
 * model still knows the room size ten turns later.
 */
export function planSummary(spec: RoomSpec, fit: Capacity = genericCapacity(spec)): string {
  const parts = [`I'm planning a styling wall ${formatLength(spec.wallCm, spec.unit)} long`];
  if (spec.depthCm) parts.push(`with about ${formatLength(spec.depthCm, spec.unit)} of depth`);
  if (spec.stations) parts.push(`and I'd like ${spec.stations} stations`);

  const lines = [`${parts.join(", ")}.`];

  lines.push(
    fit.fits > 0
      ? `Worked out at a typical ${ASSUMED.stationWidth}cm station with ${CLEARANCE.betweenStations}cm between chairs, that wall takes ${fit.fits} station${fit.fits === 1 ? "" : "s"}.`
      : `Worked out at a typical ${ASSUMED.stationWidth}cm station, that wall is too short for a full station.`,
  );

  for (const warning of fit.warnings) lines.push(warning);

  lines.push(
    "Suggest pieces from the range that suit this, and don't recalculate those numbers — they're already measured.",
  );

  return lines.join(" ");
}
