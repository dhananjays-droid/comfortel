import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  test: {
    include: ["scripts/qa/*.test.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
