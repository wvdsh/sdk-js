import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/client.ts"],
    format: ["esm"],
    platform: "browser",
    outExtension: () => ({ js: ".js" }),
    dts: true,
    splitting: false,
    sourcemap: false,
    clean: true,
    globalName: "WavedashSDK"
  },
  {
    // Parser-blocking classic bundle (deps inlined, auto-runs
    // setupWavedashSDK) injected by `wavedash dev` into game HTML, the same
    // way play injects embed.js in prod. Fetched by URL — deliberately not in
    // the package exports map.
    entry: ["src/inject.ts"],
    format: ["iife"],
    platform: "browser",
    outExtension: () => ({ js: ".global.js" }),
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    minify: true
  }
]);
