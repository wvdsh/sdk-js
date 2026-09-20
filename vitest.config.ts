import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: { deps: { inline: ["@wvdsh/api"] } },
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"]
  }
});
