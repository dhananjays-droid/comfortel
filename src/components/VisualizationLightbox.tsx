import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { downloadImage } from "@/lib/download-image";
import { cn } from "@/lib/utils";

/**
 * Full-viewport view of a render. The inline card is capped at 440px so the
 * transcript stays readable, which is far too small to judge whether a chair
 * actually sits right in the room — that judgement is the whole point of the
 * feature, so it gets its own screen.
 */
export function VisualizationLightbox({
  open,
  onClose,
  after,
  before,
  productName,
}: {
  open: boolean;
  onClose: () => void;
  after: string;
  before: string;
  productName: string;
}) {
  const canCompare = before.length > 0;
  const [view, setView] = useState<"after" | "before">("after");

  useEffect(() => {
    if (open) setView("after");
  }, [open]);

  // Arrow keys are what anyone reaches for when comparing two images.
  useEffect(() => {
    if (!open || !canCompare) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setView("before");
      else if (e.key === "ArrowRight") setView("after");
      else if (e.key.toLowerCase() === "b") setView((v) => (v === "after" ? "before" : "after"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, canCompare]);

  const src = canCompare && view === "before" ? before : after;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent
        showClose={false}
        className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 border-0 bg-ink-1/97 p-0 sm:rounded-none"
      >
        <DialogTitle className="sr-only">{productName} rendered into your space</DialogTitle>

        {/* Top bar */}
        <div className="flex shrink-0 items-center gap-3 px-4 py-3 sm:px-6">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-surface2">{productName}</p>
          <button
            type="button"
            onClick={() => void downloadImage(after, productName)}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-surface2/12 px-3.5 text-xs font-medium text-surface2 transition-colors hover:bg-surface2/22"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Download</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface2/12 text-surface2 transition-colors hover:bg-surface2/22"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Image */}
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 pb-2 sm:px-6">
          <img
            src={src}
            alt={
              view === "after" ? `${productName} rendered into your space` : "Your original photo"
            }
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>

        {/* Compare */}
        <div className="flex shrink-0 flex-col items-center gap-2 px-4 pb-5 pt-1">
          {canCompare ? (
            <>
              <div className="flex rounded-full bg-surface2/12 p-1">
                {(["before", "after"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setView(option)}
                    aria-pressed={view === option}
                    className={cn(
                      "min-w-[104px] rounded-full px-5 py-2 text-sm font-medium capitalize transition-colors",
                      view === option
                        ? "bg-primary text-primary-foreground"
                        : "text-surface2/70 hover:text-surface2",
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
              {/* Pointer devices only — there are no arrow keys to reach for on a phone. */}
              <p className="hidden text-[11px] text-surface2/45 sm:block">
                Use the arrow keys, or B, to compare
              </p>
            </>
          ) : (
            <p className="text-[11px] text-surface2/45">
              Your original photo isn&apos;t kept after a reload, so there is nothing to compare
              against.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
