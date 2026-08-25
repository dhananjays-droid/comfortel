import type { VisualizeMode } from "@/lib/visualize-prompt";

/**
 * A three-word hint does not make "swap one" versus "refit every" versus "add"
 * obvious, so each option carries a pictogram of the OUTCOME: filled glyphs are
 * the piece being placed, outlined glyphs are furniture the render leaves alone.
 * The changing silhouette count is what separates "add" from the two replaces.
 */
const SLOTS: Record<VisualizeMode, Array<"new" | "kept">> = {
  replace: ["new", "kept", "kept"],
  replace_all: ["new", "new", "new"],
  add: ["kept", "kept", "kept", "new"],
  // A whole-room refit swaps everything, so it reads the same as replace_all.
  // It is never offered in the mode picker — the assistant triggers it — but the
  // map is keyed by mode, so it needs an entry.
  refit_room: ["new", "new", "new"],
  lineup: ["new", "new", "new"],
};

const W = 78;
const GLYPH = 14;

export function VisualizeModeDiagram({ mode }: { mode: VisualizeMode }) {
  const slots = SLOTS[mode];
  const slotWidth = W / slots.length;

  return (
    <svg
      viewBox={`0 0 ${W} 32`}
      width={W}
      height={32}
      aria-hidden
      className="shrink-0 overflow-visible"
    >
      {/* floor */}
      <line x1="0" y1="28" x2={W} y2="28" stroke="currentColor" strokeWidth="1" opacity="0.25" />
      {slots.map((slot, i) => (
        <Chair key={i} x={i * slotWidth + (slotWidth - GLYPH) / 2} filled={slot === "new"} />
      ))}
    </svg>
  );
}

/**
 * Side profile, facing right: an upright back and a seat form an L, on a
 * pedestal and base plate. Drawn in profile because a front-on backrest-plus-
 * seat reads as a stool at this size, and the whole point of the diagram is to
 * remove ambiguity rather than add it.
 */
function Chair({ x, filled }: { x: number; filled: boolean }) {
  const paint = filled
    ? { fill: "currentColor", stroke: "none", opacity: 1 }
    : { fill: "none", stroke: "currentColor", strokeWidth: 1, opacity: 0.45 };

  return (
    <g {...paint}>
      {/* backrest */}
      <rect x={x} y={6} width={3} height={11} rx={1.2} />
      {/* seat */}
      <rect x={x} y={14} width={GLYPH - 2} height={3} rx={1.2} />
      {/* pedestal */}
      <rect x={x + 4.5} y={17} width={2} height={7} rx={0.8} />
      {/* base plate */}
      <rect x={x + 1.5} y={24.2} width={8} height={1.8} rx={0.9} />
    </g>
  );
}
