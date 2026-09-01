import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    // Repeated here on purpose: vitest does not read tsconfig.json paths.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
