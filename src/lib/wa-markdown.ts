/**
 * Claude's replies use standard markdown (`**bold**`, `- ` bullet lists, no
 * headings — see chat.functions.ts's SYSTEM_INSTRUCTIONS, "Style"). WhatsApp
 * renders a narrower set: `*bold*` (single asterisk), `_italic_`, `~strike~`,
 * `` `mono` ``, and plain lines for anything list-shaped — there is no
 * markdown heading syntax at all. Sent unconverted, `**bold**` shows up to
 * the customer as literal double asterisks.
 *
 * Pure — no network, no catalogue lookups, matching wa-flow.ts's own stance.
 */
export function toWhatsAppMarkdown(text: string): string {
  return (
    text
      // Headings are already instructed away (SYSTEM_INSTRUCTIONS: "No
      // headings"), but a stray one should read as a plain line, not literal
      // hashes.
      .replace(/^#{1,6}[ \t]+/gm, "")
      // **bold** -> *bold*. WhatsApp has no double-asterisk syntax at all, so
      // an unconverted run shows up to the customer as literal punctuation.
      .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "*$1*")
      // A markdown "* item" bullet, left over once bold's own "**" runs are
      // already consumed above, becomes WhatsApp's plain dash — anchored to
      // line start so it can't also eat a "*bold*" run sitting mid-line.
      .replace(/^([ \t]*)\*(?=[ \t])/gm, "$1-")
      // Stripping a heading marker off its own line leaves a hole in the
      // prose — the same cleanup chat.functions.ts already does after
      // stripping its own markers.
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
