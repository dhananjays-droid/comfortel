/** WhatsApp-only scope correction. Shared web prompt behavior is unchanged. */
export function whatsappImagePrompt(prompt: string, mode: string): string {
  if (mode === "refit_room") {
    prompt = prompt
      .replace(/If the floor visible in this photograph genuinely cannot hold[^\n]*/, "Show the exact requested quantities as distinct physical objects, excluding reflections. Preserve real room geometry and camera position. Do not shrink, overlap or hide furniture to meet counts; room fit cannot be established from a photograph alone.")
      .replace(/ — or, where the room could not take them, fewer, properly spaced, rather than crammed\./g, ". Never silently reduce the requested quantities.");
  }
  return mode === "refit_room"
    ? prompt.replace(
        /Step 1 — REMOVE: strip out the salon's existing furniture[^\n]*/,
        "Step 1 — TARGETED: replace ONLY referenced furniture types, ONLY in the stated zone. Preserve all other furniture, quantities, colours, positions and hardware. Never remove or recolour adjacent trolleys or alter other zones.",
      )
    : prompt;
}
