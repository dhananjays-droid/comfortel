import { CheckCheck, List, Lock, MessageSquare, Mic, Paperclip, Send, Smile } from "lucide-react";

import { categoryLabel, formatPrice, type FullProduct } from "@/lib/catalog";
import { CARRIER_LABEL, WA, carrierFor, clock, fit, timeOf, truncate } from "@/lib/whatsapp";
import { cn } from "@/lib/utils";

/**
 * The same conversation, as WhatsApp would actually deliver it.
 *
 * Deliberately not a themed version of the web chat. WhatsApp has no product
 * carousel, no plan tray and no before/after slider; it has three buttons, a
 * ten-row list and a catalogue. Rendering our UI in green would answer the
 * question "would this work on WhatsApp?" with a comfortable lie, so this view
 * re-expresses each turn in the primitives that actually exist and annotates
 * what the platform would drop.
 *
 * Palette is WhatsApp's own (mobile, light) rather than our design tokens —
 * the whole point is that it looks like somebody's phone.
 */

const WALLPAPER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
      <g fill="none" stroke="#d5cec3" stroke-width="1.1" stroke-linecap="round" opacity="0.55">
        <path d="M10 14c3-4 8-4 11 0"/><circle cx="52" cy="16" r="4"/>
        <path d="M20 44h10M25 39v10"/><path d="M56 46c-3 3-8 3-11 0"/>
        <path d="M8 62c4-3 9-3 13 0"/><circle cx="40" cy="66" r="3"/>
        <path d="M64 30v8"/><path d="M34 8l4 4-4 4"/>
      </g>
    </svg>`,
  );

/** What one turn becomes on WhatsApp. */
export type WaItem =
  | { id: string; from: "me" | "them"; kind: "text"; text: string }
  | { id: string; from: "me"; kind: "image"; text: string; src: string }
  | { id: string; from: "them"; kind: "products"; text: string; products: FullProduct[] }
  | {
      id: string;
      from: "them";
      kind: "renders";
      text: string;
      renders: Array<{ label: string; url?: string | undefined; loading: boolean }>;
    };

export function WhatsAppView({
  items,
  value,
  onChange,
  onSend,
  onPickPhoto,
  disabled = false,
}: {
  items: WaItem[];
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onPickPhoto: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="mx-auto w-full max-w-[820px] overflow-hidden rounded-2xl border border-border shadow-sm">
      <Header />

      <div
        className="min-h-[420px] space-y-2 px-3 py-4 sm:px-6"
        style={{ backgroundColor: "#efeae2", backgroundImage: `url("${WALLPAPER}")` }}
      >
        <SystemChip>
          <Lock className="mr-1 inline h-3 w-3" />
          Messages are end-to-end encrypted. Business messages are also read by Comfortel.
        </SystemChip>
        <SystemChip>Today</SystemChip>

        {items.length ? items.map((item) => <Turn key={item.id} item={item} />) : <WhatsAppEmpty />}
      </div>

      <Composer
        value={value}
        onChange={onChange}
        onSend={onSend}
        onPickPhoto={onPickPhoto}
        disabled={disabled}
      />
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5" style={{ backgroundColor: "#008069" }}>
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
        style={{ backgroundColor: "#25d366", color: "#0b3d2e" }}
      >
        C
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">Comfortel</p>
        <p className="truncate text-[11px] text-white/75">online</p>
      </div>
      <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium text-white">
        Business
      </span>
    </div>
  );
}

function SystemChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center py-1">
      <p
        className="max-w-[85%] rounded-md px-2.5 py-1 text-center text-[11px] leading-snug"
        style={{ backgroundColor: "#ffeecd", color: "#5b5648" }}
      >
        {children}
      </p>
    </div>
  );
}

function Turn({ item }: { item: WaItem }) {
  const time = clock(timeOf(item.id));
  const mine = item.from === "me";

  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className="max-w-[85%] space-y-1 sm:max-w-[70%]">
        <Bubble mine={mine}>
          {item.kind === "image" ? (
            <img src={item.src} alt="" className="mb-1 max-h-64 w-full rounded-md object-cover" />
          ) : null}

          {item.kind === "renders" ? <Renders renders={item.renders} /> : null}

          {/*
            Meta sits with the body text, not after the list, because WhatsApp
            stamps the time on the last line of the message and keeps the
            interactive section below it. It floats so the text wraps around it.
          */}
          <div className="flow-root">
            {item.text ? <p className="whitespace-pre-wrap">{item.text}</p> : null}
            <Meta time={time} mine={mine} />
          </div>

          {item.kind === "products" ? <ProductList products={item.products} /> : null}
        </Bubble>

        {item.kind === "products" ? <Constraint products={item.products} /> : null}
      </div>
    </div>
  );
}

function Bubble({ mine, children }: { mine: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "relative rounded-lg px-2 pb-1.5 pt-1.5 text-[14.2px] leading-[19px] shadow-sm",
        mine ? "rounded-tr-none" : "rounded-tl-none",
      )}
      style={{ backgroundColor: mine ? "#d9fdd3" : "#ffffff", color: "#111b21" }}
    >
      {/* The tail. WhatsApp squares off the top corner nearest the sender. */}
      <span
        aria-hidden
        className={cn("absolute top-0 h-3 w-2", mine ? "-right-2" : "-left-2")}
        style={{
          backgroundColor: mine ? "#d9fdd3" : "#ffffff",
          clipPath: mine ? "polygon(0 0, 100% 0, 0 100%)" : "polygon(0 0, 100% 0, 100% 100%)",
        }}
      />
      {children}
    </div>
  );
}

function Meta({ time, mine }: { time: string; mine: boolean }) {
  return (
    <span className="float-right ml-2 mt-1 flex items-center gap-0.5 text-[11px] leading-none">
      <span style={{ color: "#667781" }}>{time}</span>
      {mine ? <CheckCheck className="h-3.5 w-3.5" style={{ color: "#53bdeb" }} /> : null}
    </span>
  );
}

function Renders({
  renders,
}: {
  renders: Array<{ label: string; url?: string | undefined; loading: boolean }>;
}) {
  return (
    <div className="mb-1 space-y-1.5">
      {renders.map((render) => (
        <div key={render.label}>
          {render.url ? (
            <img src={render.url} alt={render.label} className="w-full rounded-md object-cover" />
          ) : (
            <div
              className="flex h-40 w-full items-center justify-center rounded-md text-xs"
              style={{ backgroundColor: "#e9e4dc", color: "#667781" }}
            >
              {render.loading ? "Generating your render…" : "Render unavailable"}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A list message: the only primitive that carries a set of products with prices
 * on WhatsApp without a synced Meta catalogue. Rendered already-open, since the
 * sheet is the part worth judging.
 */
function ProductList({ products }: { products: FullProduct[] }) {
  const { kept } = fit(products, WA.listRows);

  return (
    <div className="mt-1.5">
      <div className="-mx-2 border-t" style={{ borderColor: "#e9edef" }}>
        <div
          className="flex items-center justify-center gap-1.5 py-1.5 text-[14px] font-medium"
          style={{ color: "#027eb5" }}
        >
          <List className="h-4 w-4" />
          View items
        </div>
      </div>

      <div className="-mx-2 -mb-1.5 divide-y" style={{ borderColor: "#e9edef" }}>
        {kept.map((product) => (
          <div key={product.id} className="flex items-start gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-medium" style={{ color: "#111b21" }}>
                {truncate(product.name, WA.listRowTitle)}
              </p>
              <p className="truncate text-[12px]" style={{ color: "#667781" }}>
                {truncate(
                  `${categoryLabel(product.category)} · ${formatPrice(product.price ?? 0)}`,
                  WA.listRowDescription,
                )}
              </p>
            </div>
            <span
              className="mt-0.5 h-4 w-4 shrink-0 rounded-full border"
              style={{ borderColor: "#8696a0" }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Our own annotation, deliberately not WhatsApp-styled so nobody mistakes it for
 * part of the mock. This is the answer to "what breaks on WhatsApp".
 */
function Constraint({ products }: { products: FullProduct[] }) {
  const carrier = carrierFor(products.length);
  const { dropped } = fit(products, WA.listRows);
  const truncated = products.filter((p) => p.name.length > WA.listRowTitle).length;

  // The preview above always draws a list sheet, so the note has to say which
  // primitive this set really needs and what the sheet is therefore hiding.
  // Saying "multi-product message" and "2 cut because lists hold 10" in the same
  // breath was contradictory: a catalogue message holds 30 and cuts nothing.
  const verdict =
    carrier === "too-many"
      ? `Over the ${WA.catalogProducts}-product catalogue limit — this reply cannot be sent as one message`
      : carrier === "catalog"
        ? `past the ${WA.listRows}-row list limit, so it needs a synced Meta catalogue`
        : null;

  return (
    <div
      className="rounded-md border border-dashed px-2 py-1.5 text-[11px] leading-snug"
      style={{ borderColor: "#9aa6ad", color: "#4a5760", backgroundColor: "#ffffffb0" }}
    >
      <span className="font-medium">{CARRIER_LABEL[carrier]}</span>
      {" · "}
      {products.length} {products.length === 1 ? "item" : "items"}
      {verdict ? <span className="text-[#a8321e]">{` · ${verdict}`}</span> : null}
      {verdict && dropped.length ? <span>{` · showing the first ${WA.listRows} here`}</span> : null}
      {truncated ? (
        <span>
          {" · "}
          {truncated} name{truncated === 1 ? "" : "s"} trimmed to {WA.listRowTitle} chars
        </span>
      ) : null}
    </div>
  );
}

/**
 * The real composer, wearing WhatsApp's clothes. Two composers on one screen —
 * a working one below a decorative one — would be worse than either.
 */
function Composer({
  value,
  onChange,
  onSend,
  onPickPhoto,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onPickPhoto: () => void;
  disabled: boolean;
}) {
  const empty = value.trim().length === 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!empty && !disabled) onSend();
      }}
      className="flex items-center gap-2 px-2 py-2"
      style={{ backgroundColor: "#f0f2f5" }}
    >
      <div
        className="flex flex-1 items-center gap-2 rounded-full px-3 py-2"
        style={{ backgroundColor: "#ffffff" }}
      >
        <Smile className="h-5 w-5 shrink-0" style={{ color: "#54656f" }} />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Explicit rather than relying on a form's implicit submit, and the
            // isComposing guard stops Enter firing mid-IME-composition — same
            // contract as ChatComposer, so the two composers behave alike.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!empty && !disabled) onSend();
            }
          }}
          disabled={disabled}
          placeholder="Message"
          aria-label="Message Comfortel on WhatsApp"
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[#8696a0] disabled:opacity-60"
          style={{ color: "#111b21" }}
        />
        <button type="button" onClick={onPickPhoto} aria-label="Attach a photo">
          <Paperclip className="h-5 w-5 shrink-0" style={{ color: "#54656f" }} />
        </button>
      </div>
      <button
        type="submit"
        disabled={disabled}
        aria-label={empty ? "Voice message" : "Send"}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full disabled:opacity-60"
        style={{ backgroundColor: "#00a884" }}
      >
        {empty ? <Mic className="h-5 w-5 text-white" /> : <Send className="h-5 w-5 text-white" />}
      </button>
    </form>
  );
}

/** Nothing has been said yet — WhatsApp would just show an empty thread. */
function WhatsAppEmpty() {
  return (
    <div className="flex flex-col items-center gap-1.5 py-12 text-center">
      <MessageSquare className="h-5 w-5" style={{ color: "#8696a0" }} />
      <p className="max-w-[240px] text-xs leading-snug" style={{ color: "#667781" }}>
        Send a message to see this assistant as WhatsApp would deliver it.
      </p>
    </div>
  );
}
