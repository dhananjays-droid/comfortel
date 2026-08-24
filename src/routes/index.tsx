import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";

import { ProductCard } from "@/components/ProductCard";
import { VisualizeModal } from "@/components/VisualizeModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { chat, type ChatMessageInput } from "@/lib/chat.functions";
import { getProduct, type FullProduct } from "@/lib/catalog";

const TITLE = "Comfortel — Product Discovery Assistant";
const DESCRIPTION =
  "Chat with our assistant to find salon and spa furniture, then see any piece placed in a photo of your own space.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Message = {
  role: "user" | "assistant";
  content: string;
  productIds?: string[];
};

const SEED_PROMPTS = [
  "Show me chairs for a small living room",
  "I need something to brighten up a dark corner",
  "What works with a wooden dining table?",
];

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-2" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-4"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

function Index() {
  const sendChat = useServerFn(chat);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [visualizing, setVisualizing] = useState<FullProduct | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef<Message[] | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  async function run(history: Message[]) {
    setLoading(true);
    setFailed(false);
    lastSentRef.current = history;
    try {
      const payload: ChatMessageInput[] = history
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await sendChat({ data: { messages: payload } });
      setMessages([
        ...history,
        { role: "assistant", content: res.text, productIds: res.productIds },
      ]);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    const next: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    void run(next);
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen w-full max-w-[780px] flex-col px-4 sm:px-6">
        <header className="border-b border-border py-6">
          <h1 className="text-lg font-semibold tracking-tight text-ink-1">Comfortel</h1>
          <p className="mt-1 text-sm text-ink-3">
            Tell us about your space — we&apos;ll find the pieces that fit.
          </p>
        </header>

        <main className="flex-1 py-8">
          {messages.length === 0 && !loading ? (
            <div className="space-y-5">
              <p className="text-sm text-ink-2">
                What are you looking for today? Start with one of these, or just describe your space.
              </p>
              <div className="flex flex-col gap-2">
                {SEED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => send(prompt)}
                    className="rounded-xl border border-border bg-surface px-4 py-3 text-left text-sm text-ink-1 transition-colors hover:bg-primary-soft"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((message, index) =>
                message.role === "user" ? (
                  <div key={index} className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-ink-1">
                      {message.content}
                    </p>
                  </div>
                ) : (
                  <div key={index} className="space-y-4">
                    {message.content ? (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-1">
                        {message.content}
                      </p>
                    ) : null}
                    {message.productIds && message.productIds.length > 0 ? (
                      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
                        {message.productIds.map((id) => {
                          const product = getProduct(id);
                          if (!product) return null;
                          return (
                            <ProductCard
                              key={id}
                              product={product}
                              onVisualize={setVisualizing}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ),
              )}

              {loading ? <TypingDots /> : null}

              {failed ? (
                <div className="space-y-2">
                  <p className="text-sm text-ink-2">Something went wrong — try that again?</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border"
                    onClick={() => lastSentRef.current && void run(lastSentRef.current)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
            </div>
          )}
          <div ref={endRef} />
        </main>

        <form
          className="sticky bottom-0 flex gap-2 border-t border-border bg-background py-4"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe what you're looking for"
            className="h-11 border-border bg-surface2 text-sm text-ink-1 placeholder:text-ink-4"
          />
          <Button
            type="submit"
            disabled={loading || input.trim().length === 0}
            className="h-11 bg-primary px-5 text-primary-foreground hover:bg-primary-strong"
          >
            Send
          </Button>
        </form>
      </div>

      <VisualizeModal
        product={visualizing}
        open={visualizing !== null}
        onClose={() => setVisualizing(null)}
      />
    </div>
  );
}
