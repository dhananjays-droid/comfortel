/** WhatsApp-only scope correction. Shared web prompt behavior is unchanged. */
export function whatsappImagePrompt(prompt: string, mode: string): string {
  if (mode === "refit_room") {
    prompt = prompt
      .replace(/If the floor visible in this photograph genuinely cannot hold.*?(?=\n| Keep every repeat| Reproduce each product|$)/, "Show the exact requested quantities as distinct physical objects, excluding reflections. Preserve real room geometry and camera position. Do not shrink, overlap or hide furniture to meet counts; room fit cannot be established from a photograph alone.")
      .replace(/ — or, where the room could not take them, fewer, properly spaced, rather than crammed\./g, ". Never silently reduce the requested quantities.")
      .replace(/Where the salon had several of one type.*?keeping the original spacing and orientation\./, "Install only the listed quantity of each selected product, not one per existing station. Preserve furniture outside the requested change.")
      .replace(/Before you finish, check: none of the salon's original furniture[^\n]*/, "Final composition: the selected products match their references and listed quantities; unrelated original furniture and room geometry remain unchanged. Never silently reduce the requested quantities.");
  }
  if (mode === "staged_room") {
    prompt = prompt
      .replace(/COMPOSITION AND PRODUCT CONTRACT:.*?never enlarge it to hide a fit problem\./, "COMPOSITION: wide, slightly elevated corner view. Allocate a separate visible floor or wall position for every listed unit. Frame first and last stations fully; avoid occlusion. Preserve stated dimensions and realistic scale. Reflections are not extra objects. Match the assigned product references.")
      .replace("install EXACTLY this many of each, no fewer:", "install EXACTLY this many of each, no fewer and no extra copies:")
      .replace("this room has no real walls to run out of, so there is no legitimate reason to install fewer than asked.", "respect supplied room dimensions; otherwise size the room for the listed equipment and realistic spacing.")
      .replace("Nothing else branded, and no extra furniture beyond what a room like this genuinely needs.", "Use only listed furniture; decorate with surfaces and lighting, not extra equipment.")
      .replace("one wide interior view at standing eye level", "one wide interior view with all listed units separately visible");
  }
  return mode === "refit_room"
    ? prompt.replace(
        /Step 1 — REMOVE: strip out the salon's existing furniture.*?(?=\n| Step 2 — INSTALL:|$)/,
        "Step 1 — TARGETED: replace ONLY referenced furniture types, ONLY in the stated zone. Preserve all other furniture, quantities, colours, positions and hardware. Never remove or recolour adjacent trolleys or alter other zones.",
      )
    : prompt;
}
