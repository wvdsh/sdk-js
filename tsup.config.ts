import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts"],
  format: ["esm"],
  platform: "browser",
  outExtension: () => ({ js: ".js" }),
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  globalName: "WavedashSDK"
});
