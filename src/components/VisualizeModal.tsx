import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { FullProduct } from "@/lib/catalog";
import { resizeImage, type ResizedImage } from "@/lib/resize-image";
import { visualizeStart, visualizeStatus } from "@/lib/visualize.functions";
import type { VisualizeMode } from "@/lib/visualize-prompt";

const STATUS_MESSAGES = [
  "Reading your salon...",
  "Matching the lighting...",
  "Checking the mirrors...",
  "Almost there...",
];

const MAX_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40;

const MODES: Array<{ value: VisualizeMode; label: string }> = [
  { value: "replace", label: "Replace my current unit" },
  { value: "add", label: "Add to empty space" },
];

export function VisualizeModal({
  product,
  open,
  onClose,
}: {
  product: FullProduct | null;
  open: boolean;
  onClose: () => void;
}) {
  const start = useServerFn(visualizeStart);
  const status = useServerFn(visualizeStatus);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  const [preview, setPreview] = useState<string | null>(null);
  const [image, setImage] = useState<ResizedImage | null>(null);
  const [mode, setMode] = useState<VisualizeMode>("replace");
  const [loading, setLoading] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    cancelledRef.current = !open;
    if (!open) {
      setPreview(null);
      setImage(null);
      setMode("replace");
      setLoading(false);
      setResult(null);
      setError(null);
      setStatusIndex(0);
      setProgress(0);
      setDragging(false);
    }
  }, [open]);

  useEffect(() => {
    if (!loading) return;
    setStatusIndex(0);
    const id = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_MESSAGES.length);
    }, 6000);
    return () => clearInterval(id);
  }, [loading]);

  async function handleFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("That file isn't an image — please pick a photo of your salon.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That photo is larger than 10MB. Please choose a smaller one.");
      return;
    }
    try {
      const resized = await resizeImage(file);
      setImage(resized);
      setPreview(`data:image/jpeg;base64,${resized.base64}`);
      setResult(null);
    } catch {
      setError("We couldn't read that photo. Please try a different one.");
    }
  }

  async function generate() {
    if (!product || !image) return;
    setLoading(true);
    setError(null);
    setProgress(0);
    cancelledRef.current = false;
    try {
      const started = await start({
        data: {
          productId: product.id,
          roomImageBase64: image.base64,
          mode,
          aspectRatio: image.aspectRatio,
        },
      });

      if (started.imageUrl) {
        setResult(started.imageUrl);
        return;
      }
      if (!started.taskId) throw new Error("no task");

      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelledRef.current) return;
        const res = await status({ data: { taskId: started.taskId } });
        if (res.done && res.imageUrl) {
          setResult(res.imageUrl);
          return;
        }
        setProgress(Math.round((res.progress ?? 0) * 100));
      }
      setError("This is taking longer than expected. Please try again.");
    } catch {
      setError("We couldn't place the product in your salon just now.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-surface2 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-left text-base font-medium text-ink-1">
            {product?.images?.[0] ? (
              <img
                src={product.images[0]}
                alt={product.name}
                className="h-12 w-12 rounded-md object-cover"
              />
            ) : null}
            <span className="leading-snug">{product?.name}</span>
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <img
              src={result}
              alt={`${product?.name} placed in your salon`}
              className="w-full rounded-lg border border-border"
            />
            <div className="flex flex-wrap gap-2">
              <Button asChild className="bg-primary text-primary-foreground hover:bg-primary-strong">
                <a href={result} download target="_blank" rel="noreferrer">
                  Download
                </a>
              </Button>
              <Button
                variant="outline"
                className="border-border"
                onClick={() => {
                  setResult(null);
                  setPreview(null);
                  setImage(null);
                }}
              >
                Try another photo
              </Button>
            </div>
          </div>
        ) : loading ? (
          <div className="space-y-3">
            <Skeleton className="h-64 w-full rounded-lg bg-muted" />
            <p className="text-sm text-ink-3">
              {STATUS_MESSAGES[statusIndex]}
              {progress > 0 ? ` ${progress}%` : ""}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex rounded-lg border border-border bg-muted p-1">
              {MODES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setMode(option.value)}
                  aria-pressed={mode === option.value}
                  className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                    mode === option.value
                      ? "bg-surface2 text-ink-1 shadow-sm"
                      : "text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {preview ? (
              <img
                src={preview}
                alt="Your salon"
                className="w-full rounded-lg border border-border object-cover"
              />
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
                className={`flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-6 py-12 text-center transition-colors ${
                  dragging ? "border-primary-strong bg-primary-soft" : "border-border-strong bg-muted"
                }`}
              >
                <span className="text-sm font-medium text-ink-1">
                  Drag a photo here, or click to choose
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

            {error ? (
              <div className="space-y-2">
                <p className="text-sm text-ink-2">{error}</p>
                {image ? (
                  <Button variant="outline" className="border-border" onClick={() => void generate()}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!image}
                onClick={() => void generate()}
                className="bg-primary text-primary-foreground hover:bg-primary-strong"
              >
                Generate
              </Button>
              {preview ? (
                <Button
                  variant="ghost"
                  className="text-ink-3"
                  onClick={() => {
                    setPreview(null);
                    setImage(null);
                  }}
                >
                  Change photo
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
