import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Only the tsconfig "@/*" path alias, so src/ modules that import "@/lib/…" at runtime (the i18n module) load in tests.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
