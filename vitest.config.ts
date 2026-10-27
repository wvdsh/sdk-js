import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/tests/**/*.test.ts"],
    server: { deps: { inline: ["@wvdsh/api"] } }
  }
});
