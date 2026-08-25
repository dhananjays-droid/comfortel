import { ArrowUp, ImagePlus, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

const MAX_CHARS = 2000;
/** ~6 lines at the composer's line-height, then the field scrolls internally. */
const MAX_HEIGHT = 168;

export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
  photo,
  photoLoading,
  onPickPhoto,
  onClearPhoto,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  /** data: URL of the attached room photo, if any */
  photo: string | null;
  photoLoading: boolean;
  onPickPhoto: (file: File | undefined) => void;
  onClearPhoto: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Grow with the content. Collapse to 0 before measuring rather than "auto":
  // a stretched flex item ignores height:auto, so scrollHeight would report the
  // stretched box and the field would latch at MAX_HEIGHT while still empty.
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  // Stylesheet and web fonts can land after hydration, which changes the
  // line box. Re-measure once on the next frame so the first pass can't
  // freeze a height taken before the real styles applied.
  useEffect(() => {
    const frame = requestAnimationFrame(resize);
    return () => cancelAnimationFrame(frame);
  }, [resize]);

  // Pasting a screenshot straight into the composer is the fastest path on a laptop.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? [])[0];
      if (file?.type.startsWith("image/")) onPickPhoto(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPickPhoto]);

  // A photo alone is a valid message — "here's my salon" needs no words.
  const canSend = (value.trim().length > 0 || photo !== null) && !disabled;

  return (
    <div className="rounded-[22px] border border-border bg-surface2 transition-colors focus-within:border-border-strong">
      {photo ? (
        <div className="flex items-center gap-2.5 px-3 pt-3">
          <div className="relative">
            <img
              src={photo}
              alt="Your salon"
              className="h-14 w-14 rounded-xl border border-border object-cover"
            />
            <button
              type="button"
              onClick={onClearPhoto}
              aria-label="Remove photo"
              className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink-1 text-surface2 transition-opacity hover:opacity-85"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <p className="text-xs leading-snug text-ink-3">
            Your salon photo is attached.
            <br />
            Ask for anything to be rendered into it.
          </p>
        </div>
      ) : null}

      <form
        className="flex items-end gap-1.5 py-2 pl-2 pr-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSend();
        }}
      >
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach a photo of your salon"
          title="Attach a photo of your salon"
          className={cn(
            "mb-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
            photo ? "bg-primary-soft text-ink-1" : "text-ink-3 hover:bg-muted hover:text-ink-1",
          )}
        >
          {photoLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImagePlus className="h-4 w-4" />
          )}
        </button>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            onPickPhoto(e.target.files?.[0]);
            // Allow re-picking the same file after a clear.
            e.target.value = "";
          }}
        />

        <label htmlFor="chat-input" className="sr-only">
          Message the Comfortel product specialist
        </label>
        <textarea
          id="chat-input"
          ref={ref}
          rows={1}
          value={value}
          maxLength={MAX_CHARS}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder={
            photo ? "Ask what to do with this space" : "Describe the space you're fitting out"
          }
          className="max-h-[168px] min-h-[24px] flex-1 resize-none self-end bg-transparent py-1.5 text-sm leading-relaxed text-ink-1 outline-none placeholder:text-ink-4"
        />

        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="mb-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-1 text-primary transition-opacity hover:opacity-90 disabled:opacity-25"
        >
          <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
        </button>
      </form>
    </div>
  );
}
