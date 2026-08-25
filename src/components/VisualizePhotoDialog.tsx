import { Camera, Check, ImagePlus, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FullProduct } from "@/lib/catalog";
import { resizeImage, type ResizedImage } from "@/lib/resize-image";
import { cn } from "@/lib/utils";
import { VisualizeModeDiagram } from "@/components/VisualizeModeDiagram";
import type { VisualizeMode } from "@/lib/visualize-prompt";

const MAX_BYTES = 10 * 1024 * 1024;

export type VisualizeRequest = {
  /** One product for the placement modes; several for a plan refit. */
  products: FullProduct[];
  image: ResizedImage;
  preview: string;
  mode: VisualizeMode;
};

export function VisualizePhotoDialog({
  products,
  open,
  onClose,
  onSubmit,
}: {
  products: FullProduct[];
  open: boolean;
  onClose: () => void;
  onSubmit: (request: VisualizeRequest) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [image, setImage] = useState<ResizedImage | null>(null);
  const [mode, setMode] = useState<VisualizeMode>("replace_all");
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setPreview(null);
    setImage(null);
    setMode("replace_all");
    setDragging(false);
    setReading(false);
    setError(null);
  }, [open]);

  // Pasting a screenshot is the fastest path for anyone demoing this on a laptop.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? [])[0];
      if (file) void handleFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [open]);

  async function handleFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("That file isn't an image — pick a photo of your space.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That photo is over 10MB. Try a smaller one.");
      return;
    }
    setReading(true);
    try {
      const resized = await resizeImage(file);
      setImage(resized);
      setPreview(`data:image/jpeg;base64,${resized.base64}`);
    } catch {
      setError("We couldn't read that photo. Try a different one.");
    } finally {
      setReading(false);
    }
  }

  const lead = products[0];
  if (!lead) return null;

  // A plan of several products is always a whole-room refit — the mode choice
  // only makes sense for a single piece.
  const multi = products.length > 1;

  const subject = lead.replaces ?? "unit";
  // replace_all leads because it is the reliable one. Swapping a single unit
  // asks the model to track one instance among identical units, which it does
  // not do dependably — so it is offered last and labelled as approximate.
  const modes: Array<{ value: VisualizeMode; label: string; hint: string }> = [
    {
      value: "replace_all",
      label: `Refit every ${subject}`,
      hint: "Replaces all of them so the room reads as a matching set",
    },
    {
      value: "add",
      label: "Add to an empty spot",
      hint: "Leaves everything already in the room untouched",
    },
    {
      value: "replace",
      label: `Swap just one ${subject}`,
      hint: "Approximate — with several in view it may change a different one",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-border bg-surface2 sm:max-w-[520px]">
        <DialogHeader className="space-y-3">
          <DialogTitle className="flex items-center gap-3 pr-6 text-left text-base font-semibold text-ink-1">
            {lead.images?.[0] ? (
              <img
                src={lead.images[0]}
                alt=""
                className="h-11 w-11 shrink-0 rounded-lg border border-border object-contain p-0.5"
              />
            ) : null}
            <span className="leading-snug">
              {multi
                ? `See your ${products.length} pieces in your space`
                : `See the ${lead.name} in your space`}
            </span>
          </DialogTitle>
          <DialogDescription className="text-left text-sm text-ink-3">
            {multi
              ? "Upload a photo of your salon and we'll fit all of these into it in one render, each where its type belongs."
              : "Upload a photo of your salon and we'll render this piece into it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Photo */}
          {preview ? (
            <div className="relative overflow-hidden rounded-xl border border-border">
              <img src={preview} alt="Your space" className="w-full object-cover" />
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setImage(null);
                }}
                className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-ink-1/85 text-surface2 transition-colors hover:bg-ink-1"
                aria-label="Remove photo"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void handleFile(e.dataTransfer.files?.[0]);
              }}
              className={cn(
                "flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors",
                dragging
                  ? "border-primary-strong bg-primary-soft"
                  : "border-border-strong bg-muted hover:bg-secondary",
              )}
            >
              {reading ? (
                <Loader2 className="h-5 w-5 animate-spin text-ink-3" />
              ) : (
                <ImagePlus className="h-5 w-5 text-ink-3" />
              )}
              <span className="text-sm font-medium text-ink-1">
                {reading ? "Reading your photo..." : "Drop a photo, click to browse, or paste"}
              </span>
              <span className="text-xs text-ink-3">JPG or PNG, up to 10MB</span>
            </button>
          )}

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />

          {multi ? (
            <div className="space-y-2 rounded-xl border border-border bg-muted/60 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
                Going into the render
              </p>
              <ul className="space-y-1">
                {products.map((p) => (
                  <li key={p.id} className="flex items-baseline gap-2 text-xs text-ink-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] leading-snug text-ink-3">
                Your salon&apos;s existing furniture is replaced with these, each placed where its
                type belongs. Walls, flooring and fittings stay as they are.
              </p>
            </div>
          ) : (
            /* Mode — single product only */
            <fieldset className="space-y-2">
              <legend className="mb-2 flex w-full items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-ink-3">
                <span>What should we do with it?</span>
                <span className="flex items-center gap-2.5 normal-case tracking-normal">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-ink-1" />
                    this piece
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm border border-ink-3 opacity-50" />
                    left as-is
                  </span>
                </span>
              </legend>
              {modes.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setMode(option.value)}
                  aria-pressed={mode === option.value}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    mode === option.value
                      ? "border-ink-1 bg-muted"
                      : "border-border bg-transparent hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                      mode === option.value ? "border-ink-1 bg-ink-1" : "border-border-strong",
                    )}
                  >
                    {mode === option.value ? (
                      <Check className="h-2.5 w-2.5 text-primary" strokeWidth={3} />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink-1">{option.label}</span>
                    <span className="block text-xs leading-snug text-ink-3">{option.hint}</span>
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 transition-colors",
                      mode === option.value ? "text-ink-1" : "text-ink-3",
                    )}
                  >
                    <VisualizeModeDiagram mode={option.value} />
                  </span>
                </button>
              ))}
            </fieldset>
          )}

          <p className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2.5 text-xs leading-relaxed text-ink-3">
            <Camera className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Best results come from a well-lit shot taken at standing height, with the whole
              station and some floor in frame.
            </span>
          </p>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} className="text-ink-3 hover:text-ink-1">
              Cancel
            </Button>
            <Button
              disabled={!image}
              onClick={() => {
                if (!image || !preview) return;
                onSubmit({ products, image, preview, mode: multi ? "refit_room" : mode });
              }}
              className="bg-primary text-primary-foreground shadow-none hover:bg-primary-strong"
            >
              Generate
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
