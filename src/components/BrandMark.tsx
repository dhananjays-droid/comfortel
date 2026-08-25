import { cn } from "@/lib/utils";

/**
 * Comfortel monogram. Used as the assistant's avatar and in the header, so it
 * has to read at 24px — a single letterform, not a logo lockup.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-ink-1 text-[0.7em] font-semibold leading-none tracking-tight text-primary",
        className,
      )}
    >
      C
    </span>
  );
}
