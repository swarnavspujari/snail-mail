import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tauri expects a fixed dev port; clearScreen off keeps Rust errors visible.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Array form because ORDER MATTERS: the demo-backend entry has to be tried
    // before the "@" prefix entry, or "@" resolves it first and the swap
    // silently never happens. mode === "desktop" comes from the dev:desktop /
    // build:desktop scripts, which is what tauri.conf.json runs — so desktop
    // bundles get the stub and never import mock.ts / mock-data.ts at all.
    alias: [
      ...(mode === "desktop"
        ? [
            {
              find: /^@\/lib\/demo-backend$/,
              replacement: path("./src/lib/demo-backend.desktop.ts"),
            },
          ]
        : []),
      { find: "@", replacement: path("./src") },
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust saves must not full-reload the webview mid-edit
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
}));
