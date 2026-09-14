/** WhatsApp-only scope correction. Shared web prompt behavior is unchanged. */
export function whatsappImagePrompt(prompt: string, mode: string): string {
  return mode === "refit_room"
    ? prompt.replace(
        /Step 1 — REMOVE: strip out the salon's existing furniture[^\n]*/,
        "Step 1 — TARGETED: replace ONLY referenced furniture types, ONLY in the stated zone. Preserve all other furniture, quantities, colours, positions and hardware. Never remove or recolour adjacent trolleys or alter other zones.",
      )
    : prompt;
}
