import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "browser",
  outExtension: () => ({ js: ".js" }),
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  external: [],
  noExternal: ["convex", "lodash.unionby"],
  globalName: "WavedashSDK"
});
