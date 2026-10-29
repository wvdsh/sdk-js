import path from "node:path";
import { build, type Format, type Plugin } from "esbuild";
import { defineConfig } from "tsup";

const BUNDLE_SOURCE = /\?(worker|module)-source$/;

const bundleSourcePlugin: Plugin = {
  name: "bundle-source",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: BUNDLE_SOURCE }, (args) => {
      const [, kind] = BUNDLE_SOURCE.exec(args.path)!;
      return {
        path: path.resolve(
          args.resolveDir,
          args.path.replace(BUNDLE_SOURCE, "")
        ),
        namespace: "bundle-source",
        pluginData: { format: kind === "worker" ? "iife" : "esm" }
      };
    });
    pluginBuild.onLoad(
      { filter: /.*/, namespace: "bundle-source" },
      async (args) => {
        const result = await build({
          entryPoints: [args.path],
          bundle: true,
          write: false,
          metafile: true,
          format: args.pluginData.format as Format,
          platform: "browser",
          target: "es2022",
          minify: true,
          plugins: [bundleSourcePlugin]
        });
        return {
          contents: result.outputFiles[0].text,
          loader: "text",
          watchFiles: Object.keys(result.metafile.inputs)
            .filter((input) => !input.startsWith("bundle-source:"))
            .map((input) => path.resolve(input))
        };
      }
    );
  }
};

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
    globalName: "WavedashSDK",
    esbuildPlugins: [bundleSourcePlugin]
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
    minify: true,
    esbuildPlugins: [bundleSourcePlugin]
  }
]);
