import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { FullProduct } from "@/lib/catalog";
import { resizeToBase64 } from "@/lib/resize-image";
import { visualize } from "@/lib/visualize.functions";

const STATUS_MESSAGES = [
  "Reading your room...",
  "Matching the lighting...",
  "Almost there...",
];

const MAX_BYTES = 10 * 1024 * 1024;

export function VisualizeModal({
  product,
  open,
  onClose,
}: {
  product: FullProduct | null;
  open: boolean;
  onClose: () => void;
}) {
  const runVisualize = useServerFn(visualize);
  const inputRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [base64, setBase64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setBase64(null);
      setLoading(false);
      setResult(null);
      setError(null);
      setStatusIndex(0);
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
      setError("That file isn't an image — please pick a photo of your room.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That photo is larger than 10MB. Please choose a smaller one.");
      return;
    }
    try {
      const encoded = await resizeToBase64(file);
      setBase64(encoded);
      setPreview(`data:image/jpeg;base64,${encoded}`);
      setResult(null);
    } catch {
      setError("We couldn't read that photo. Please try a different one.");
    }
  }

  async function generate() {
    if (!product || !base64) return;
    setLoading(true);
    setError(null);
    try {
      const res = await runVisualize({ data: { productId: product.id, roomImageBase64: base64 } });
      setResult(res.imageUrl);
    } catch {
      setError("We couldn't place the product in your room just now.");
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
              alt={`${product?.name} placed in your room`}
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
                  setBase64(null);
                }}
              >
                Try another photo
              </Button>
            </div>
          </div>
        ) : loading ? (
          <div className="space-y-3">
            <Skeleton className="h-64 w-full rounded-lg bg-muted" />
            <p className="text-sm text-ink-3">{STATUS_MESSAGES[statusIndex]}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {preview ? (
              <img
                src={preview}
                alt="Your room"
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
                {base64 ? (
                  <Button variant="outline" className="border-border" onClick={() => void generate()}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!base64}
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
                    setBase64(null);
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
