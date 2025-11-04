import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs", "iife"],
  platform: "browser",
  // These options help when building in CI/CD where peer deps might not be installed
  dts: {
    resolve: true,
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [],
  noExternal: ["convex", "lodash.unionby"],
  globalName: "WavedashSDK",
});
