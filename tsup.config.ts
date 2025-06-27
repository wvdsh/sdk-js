import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  // These options help when building in CI/CD where peer deps might not be installed
  dts: {
    resolve: true,
    compilerOptions: {
      skipLibCheck: true,
    }
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["convex"],
  noExternal: [],
  globalName: "WavedashSDK",
});
