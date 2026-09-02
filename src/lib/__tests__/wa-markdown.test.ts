import { describe, expect, it } from "vitest";

import { toWhatsAppMarkdown } from "@/lib/wa-markdown";

/**
 * No live Anthropic key in this test environment (see wa-runtime.test.ts's
 * header comment), so these samples are hand-written to the exact shape
 * chat.functions.ts's SYSTEM_INSTRUCTIONS asks the model for — plain prose,
 * **bold** for emphasis, an occasional short bullet list, no headings, no
 * emoji — rather than pulled from a real response. Re-check against a real
 * transcript once the assistant is live and this can be verified for real.
 */
describe("toWhatsAppMarkdown", () => {
  it("converts double-asterisk bold to WhatsApp's single-asterisk bold", () => {
    expect(toWhatsAppMarkdown("The **Blake** styling chair suits a modern salon.")).toBe(
      "The *Blake* styling chair suits a modern salon.",
    );
  });

  it("converts several bold runs in one reply", () => {
    const input = "Both the **Blake** and the **Harlow** come in oxblood.";
    expect(toWhatsAppMarkdown(input)).toBe("Both the *Blake* and the *Harlow* come in oxblood.");
  });

  it("leaves a plain dash bullet list untouched", () => {
    const input = [
      "Here are two options:",
      "",
      "- The Blake — hydraulic base",
      "- The Harlow — fixed base",
    ].join("\n");
    expect(toWhatsAppMarkdown(input)).toBe(input);
  });

  it("normalizes an asterisk bullet list to WhatsApp's plain dash", () => {
    const input = ["Two options:", "", "* The Blake", "* The Harlow"].join("\n");
    expect(toWhatsAppMarkdown(input)).toBe(
      ["Two options:", "", "- The Blake", "- The Harlow"].join("\n"),
    );
  });

  it("doesn't let a bullet-list normalization eat a bold run sitting on the same line", () => {
    const input = "* The **Blake** — hydraulic base";
    expect(toWhatsAppMarkdown(input)).toBe("- The *Blake* — hydraulic base");
  });

  it("strips a stray heading marker rather than showing literal hashes", () => {
    expect(toWhatsAppMarkdown("## Recommended pieces\nThe Blake suits you.")).toBe(
      "Recommended pieces\nThe Blake suits you.",
    );
  });

  it("collapses the blank line a stripped marker can leave behind", () => {
    expect(toWhatsAppMarkdown("Line one.  \nLine two.\n\n\n\nLine three.")).toBe(
      "Line one.\nLine two.\n\nLine three.",
    );
  });

  it("passes plain prose through unchanged", () => {
    const input = "The Blake suits a modern salon. It comes in black, oxblood and cream.";
    expect(toWhatsAppMarkdown(input)).toBe(input);
  });
});
