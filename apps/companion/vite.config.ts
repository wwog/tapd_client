import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Companion SPA: served by the desktop app's rust-embed, so assets must use
// relative paths and land where the embedder looks for them.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  base: "./",
  server: {
    port: 1421,
    strictPort: true,
  },
  build: {
    target: "safari16",
    outDir: "../desktop/src-tauri/dist-companion",
    emptyOutDir: true,
  },
});
