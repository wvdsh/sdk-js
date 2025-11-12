import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["iife"],
  platform: "browser",
  outExtension: () => ({ js: ".js" }),
  dts: false,
  splitting: false,
  sourcemap: false,
  clean: true,
  external: [],
  noExternal: ["convex", "lodash.unionby"],
  globalName: "WavedashSDK",
});
