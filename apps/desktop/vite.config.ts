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
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "vendor-react";
          }
          if (id.includes("node_modules")) {
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
