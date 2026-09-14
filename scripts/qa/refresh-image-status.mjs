// Read only existing Kie task IDs. Never submits a generation.
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
const key = parseEnv(readFileSync(".env", "utf8")).KIE_API_KEY;
const dir = "outputs/qa-2026-09-14-after";
const data = JSON.parse(readFileSync(`${dir}/images.json`, "utf8"));
for (const row of data.results.filter((row) => row.taskId && !row.imageUrl)) {
  const response = await fetch(
    `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(row.taskId)}`,
    { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) },
  );
  const json = await response.json();
  row.lastObservedState = json.data?.state ?? "unavailable";
  row.lastObservedAt = new Date().toISOString();
  if (json.data?.state === "success") {
    const result =
      typeof json.data.resultJson === "string"
        ? JSON.parse(json.data.resultJson)
        : json.data.resultJson;
    row.imageUrl = result.resultUrls[0];
    row.lateResult = true;
    row.ms = Date.now() - Date.parse(row.startedAt);
    const image = await fetch(row.imageUrl, { signal: AbortSignal.timeout(20000) });
    if (image.ok) {
      writeFileSync(`${dir}/${row.id}.png`, Buffer.from(await image.arrayBuffer()));
      row.localPath = `${dir}/${row.id}.png`;
    }
  }
  console.log(
    JSON.stringify({
      id: row.id,
      state: row.lastObservedState,
      lateResult: row.lateResult ?? false,
    }),
  );
}
writeFileSync(`${dir}/images.json`, JSON.stringify(data, null, 2));
