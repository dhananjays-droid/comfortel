import { ArrowRight, Camera, Layers } from "lucide-react";
import { useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * The first screen.
 *
 * It was a headline, a paragraph and four identical pills above a large empty
 * space, which had three problems: nothing showed what the product actually
 * does, every entry point looked equally important when uploading a photo is
 * the one that matters, and the fold was mostly void.
 *
 * So: one primary action carrying a picture of the outcome, four typed starters
 * demoted to secondary, and the dead space below filled with the three steps —
 * which is the thing people are actually unsure about.
 */

/**
 * One way in, not three.
 *
 * This was "A whole salon", "To a budget" and "Plan by dimensions", which all
 * opened the same dialog with different fields hidden. Three tiles implied
 * three different answers and made the customer categorise their own question
 * first — badly, for anyone who had both a budget and a tape measure. The
 * dialog now asks for everything and requires almost none of it, so there is
 * one door.
 */

const STEPS = [
  { n: 1, text: "Tell us the space, or pick from the range" },
  { n: 2, text: "Add a photo of your salon" },
  { n: 3, text: "See the pieces installed in it" },
];

export function EmptyState({
  onPick,
  onPickPhoto,
  onOpenWizard,
}: {
  onPick: (prompt: string) => void;
  /** Same handler the composer uses, so a photo picked here behaves identically. */
  onPickPhoto: (file: File | undefined) => void;
  onOpenWizard: () => void;
}) {
  // Its own input rather than reaching for the composer's: this button exists
  // before the composer matters, and sharing a DOM node across two components
  // for one click is not worth the coupling.
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    // Bottom padding clears the sticky composer: without it the steps row ends
    // exactly where the composer begins and is permanently occluded on mobile.
    <div className="pb-20 pt-10 sm:pb-14 sm:pt-14">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onPickPhoto(e.target.files?.[0])}
      />
      <div className="max-w-[560px] animate-in fade-in duration-500">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink-1 sm:text-3xl">
          What are you fitting out?
        </h1>
        <p className="mt-2.5 text-sm leading-relaxed text-ink-3">
          Describe the space and we&apos;ll pull the right pieces from the Comfortel range — then
          render them into a photo of your own salon.
        </p>
      </div>

      {/* Primary: the thing that makes this different from a catalogue. */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={cn(
          "group mt-7 flex w-full animate-in items-center gap-4 rounded-2xl border border-border-strong bg-surface2 p-4 text-left fade-in slide-in-from-bottom-2 duration-500",
          "transition-all hover:border-ink-1 hover:shadow-[0_1px_2px_rgba(15,15,12,0.04),0_10px_28px_-14px_rgba(15,15,12,0.22)]",
          "sm:p-5",
        )}
        style={{ animationDelay: "60ms" }}
      >
        <span className="hidden shrink-0 sm:block">
          <RoomSwapDiagram />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <Camera className="h-4 w-4 shrink-0 text-ink-2" />
            <span className="text-sm font-semibold text-ink-1">
              Start with a photo of your salon
            </span>
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-ink-3">
            Drop in one photo and see any piece standing in your own room, in its place, at the
            right scale.
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-1" />
      </button>

      {/* Secondary: the one guided way in, for people without a photo yet. */}
      <button
        type="button"
        onClick={onOpenWizard}
        className={cn(
          "group mt-3 flex w-full animate-in items-center gap-3 rounded-2xl border border-border bg-surface2/60 p-4 text-left fade-in slide-in-from-bottom-2 duration-500",
          "transition-colors hover:border-border-strong hover:bg-surface2",
        )}
        style={{ animationDelay: "120ms" }}
      >
        <Layers className="h-4 w-4 shrink-0 text-ink-2" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink-1">
            Or plan it out without a photo
          </span>
          <span className="mt-0.5 block text-sm leading-relaxed text-ink-3">
            Tell us the room, the stations or the wall length, and a budget — we&apos;ll come back
            with three ways to do it.
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-1" />
      </button>

      {/* The void below the fold, spent on the question people actually have. */}
      <ol
        className="mt-8 animate-in grid gap-3 border-t border-border pt-6 fade-in duration-700 sm:grid-cols-3"
        style={{ animationDelay: "340ms" }}
      >
        {STEPS.map((step) => (
          <li key={step.n} className="flex items-start gap-2.5">
            <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-ink-2">
              {step.n}
            </span>
            <span className="text-xs leading-snug text-ink-3">{step.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Their room, then their room fitted out.
 *
 * Deliberately the same glyph language as VisualizeModeDiagram — outlined is
 * furniture left alone, filled is a Comfortel piece placed — so this reads as
 * the same idea the mode picker uses later, not as decoration. A diagram rather
 * than a screenshot because a fake screenshot would be a promise about output
 * quality we cannot keep for every room.
 */
function RoomSwapDiagram() {
  return (
    <svg viewBox="0 0 118 52" width="118" height="52" aria-hidden className="text-ink-2">
      <Panel x={0} filled={false} />
      <g className="text-ink-4">
        <path
          d="M53 26 h11"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.6"
        />
        <path
          d="M61 23 l3.5 3 -3.5 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.6"
        />
      </g>
      <Panel x={70} filled />
    </svg>
  );
}

/** One room: a floor line, a wall, and three chairs on it. */
function Panel({ x, filled }: { x: number; filled: boolean }) {
  const paint = filled
    ? { fill: "currentColor", stroke: "none", opacity: 1 }
    : { fill: "none", stroke: "currentColor", strokeWidth: 1, opacity: 0.4 };

  return (
    <g>
      <rect
        x={x + 0.5}
        y={4.5}
        width={47}
        height={43}
        rx={5}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        opacity={filled ? 0.35 : 0.18}
      />
      <line
        x1={x + 6}
        y1={38}
        x2={x + 42}
        y2={38}
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.25"
      />
      {[0, 1, 2].map((i) => (
        <g key={i} {...paint}>
          {/* backrest, seat, column and base — side profile, facing right */}
          <rect x={x + 9 + i * 12} y={20} width={2.4} height={9} rx={1} />
          <rect x={x + 9 + i * 12} y={26.6} width={8} height={2.4} rx={1} />
          <rect x={x + 12 + i * 12} y={29} width={1.6} height={6} rx={0.8} />
          <rect x={x + 9.5 + i * 12} y={35} width={7} height={1.8} rx={0.9} />
        </g>
      ))}
    </g>
  );
}
