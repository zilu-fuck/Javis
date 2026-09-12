import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Use project-local cache to avoid monorepo cross-contamination
  cacheDir: "node_modules/.vite-desktop",
  // Prevent monorepo package symlinks from being pre-bundled
  optimizeDeps: {
    exclude: ["@javis/core", "@javis/ui", "@javis/tools"],
  },
  resolve: {
    // Ensure workspace packages resolve to source (not stale dist)
    conditions: ["development", "browser"],
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Splits the bundle by dependency family.
         *
         * The previous rule put every `node_modules` module except React into a single
         * `vendor` chunk, which the build reported at ~4.7 MB. That is worse than a large
         * number: any change to any dependency, and any change to application code that
         * shares the chunk, invalidates the whole blob in the browser cache, and the
         * "chunk larger than 500 kB" warning names a bag instead of a culprit.
         *
         * Families are ordered most specific first; the catch-all stays last so an
         * unrecognised dependency still lands somewhere predictable.
         */
        manualChunks(id) {
          const inNodeModules = id.includes("node_modules");
          if (inNodeModules && (id.includes("node_modules/react-dom") || id.includes("node_modules/react/"))) {
            return "vendor-react";
          }
          // The langchain family is the heavy one and is only needed by the langchain
          // execution kernel, so it is worth keeping separately cacheable.
          if (inNodeModules && (id.includes("node_modules/langchain") || id.includes("node_modules/@langchain"))) {
            return "vendor-langchain";
          }
          if (inNodeModules && id.includes("node_modules/@tauri-apps")) {
            return "vendor-tauri";
          }
          /**
           * The TypeScript compiler (~9.2 MB rendered, measured by
           * `scripts/analyze-bundle.mjs`) gets its own chunk.
           *
           * This is what makes the lazy import in `app-runtime.ts` effective: while the
           * compiler was assigned to the catch-all `vendor` chunk — which the entry
           * imports statically — a dynamic import of the service could not pull it out of
           * the initial bundle, it merely referenced it. Isolated here, the compiler is
           * reached only through `repo-intelligence-service`, so it loads on demand.
           */
          if (inNodeModules && id.includes("node_modules/typescript/")) {
            return "vendor-typescript";
          }
          if (inNodeModules) {
            return "vendor";
          }
          if (id.includes("/packages/core/src/") || id.includes("\\packages\\core\\src\\")) {
            return "javis-core";
          }
          if (id.includes("/packages/ui/src/") || id.includes("\\packages\\ui\\src\\")) {
            return "javis-ui";
          }
        },
      },
    },
  },
}));
