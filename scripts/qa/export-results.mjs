import { readFileSync, writeFileSync } from "node:fs";
const dir = new URL("../../outputs/qa-2026-09-14-after/", import.meta.url);
const data = JSON.parse(readFileSync(new URL("questions.json", dir), "utf8"));
const lines = [
  "# All 100 customer questions and actual responses",
  "",
  "Synthetic conversations; real chat model and application routing; isolated persistence/delivery. These transcripts record observed behavior, not approved answers.",
  "",
];
for (const row of data.results) {
  lines.push(
    `## ${row.id} — ${row.journey}`,
    "",
    `Customer: ${row.question}`,
    "",
    `Route: ${row.route}. Response time: ${row.ms} ms.`,
    "",
  );
  for (const turn of row.turns) {
    if (turn.text) lines.push(turn.text, "");
    if (turn.caption) lines.push(turn.caption, "");
    if (turn.kind === "image")
      lines.push(`Image: ${turn.url ?? turn.imageUrl ?? "product image"}`, "");
    if (turn.kind === "document") lines.push(`PDF: ${turn.filename}`, "");
    if (turn.action?.buttons)
      lines.push(`Buttons: ${turn.action.buttons.map((b) => b.title).join(" | ")}`, "");
  }
  if (row.error) lines.push(`Error: ${row.error}`, "");
  lines.push(
    `Saved plan: ${JSON.stringify(row.state.plan)}. Active request: ${row.state.request?.category ?? "none"} / ${row.state.request?.status ?? "none"}. Image confirmation: ${row.state.pendingRender?.mode ?? "none"}.`,
    "",
  );
}
writeFileSync(new URL("QUESTIONS.md", dir), lines.join("\n"));
console.log(`Exported ${data.results.length} questions.`);
