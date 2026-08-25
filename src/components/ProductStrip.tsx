import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Horizontal card rail. Scroll-snaps on touch; on pointer devices it also gets
 * arrow buttons, because a trackpad user has no obvious affordance that the row
 * continues past the fold.
 */
export function ProductStrip({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setAtStart(el.scrollLeft <= 4);
    setAtEnd(el.scrollLeft >= max - 4);
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, children]);

  const nudge = (direction: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(240, el.clientWidth * 0.8), behavior: "smooth" });
  };

  const showArrows = !atStart || !atEnd;

  return (
    <div className="group/strip relative">
      <div
        ref={ref}
        onScroll={measure}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      >
        {children}
      </div>

      {showArrows ? (
        <>
          <StripArrow side="left" disabled={atStart} onClick={() => nudge(-1)} />
          <StripArrow side="right" disabled={atEnd} onClick={() => nudge(1)} />
        </>
      ) : null}
    </div>
  );
}

function StripArrow({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "absolute top-[38%] z-10 hidden h-8 w-8 items-center justify-center rounded-full border border-border bg-surface2 text-ink-2 shadow-sm transition-all",
        "hover:bg-muted md:flex",
        "opacity-0 group-hover/strip:opacity-100 focus-visible:opacity-100",
        disabled && "pointer-events-none !opacity-0",
        side === "left" ? "-left-3" : "-right-3",
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
