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
         * Two rules only, and the restraint is deliberate.
         *
         * An earlier version of this function also split `vendor` into per-family chunks
         * (langchain, tauri). The unit suite stayed green, but loading the built bundle in a
         * real browser showed the app failing to mount:
         *
         *   Cannot read properties of undefined (reading 'PureComponent')
         *
         * The extra partitions changed module initialization order, so a dependency that reads
         * React at init time ran before the React chunk. Only a real browser caught it — every
         * one of the ~2,900 jsdom tests passed with the broken bundle, because they import
         * modules directly and never load the production bundle. See `.dsh-tmp/e2e-smoke.mjs`.
         *
         * The measured 9.2 MB win comes from the compiler chunk alone, so the family splits were
         * not worth the ordering risk. React keeps its own chunk: that rule predates this change
         * and is verified by the browser test.
         */
        manualChunks(id) {
          const inNodeModules = id.includes("node_modules");
          /**
           * The React rule is the ORIGINAL broad match, deliberately.
           *
           * Narrowing it to `node_modules/react/` looked harmless and was not: it moved
           * `react-window` and friends out of the React chunk into `vendor`, which changed which
           * chunk initializes first and left them reading `React.PureComponent` on an undefined
           * React. The app then failed to mount with nothing but "正在启动…" on screen.
           *
           * The browser test (`node .dsh-tmp/e2e-smoke.mjs`) is what caught it: the anchor here
           * must stay `node_modules/react` — matching React's ecosystem, not just the core.
           */
          if (inNodeModules && id.includes("node_modules/react")) {
            return "vendor-react";
          }
          /**
           * The TypeScript compiler (~9.2 MB rendered, measured by `scripts/analyze-bundle.mjs`)
           * gets its own chunk. This is what makes the lazy import in `app-runtime.ts` effective:
           * while the compiler was assigned to the catch-all `vendor` chunk — which the entry
           * imports statically — a dynamic import of the service could not pull it out of the
           * initial bundle, it merely referenced it.
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
