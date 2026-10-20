import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `vite build` -> dist/web, served by the Fastify server (talks to /api).
// `vite build --mode standalone` -> self-contained preview that runs the same
// core engine in the browser with simulated data only (no server, no broker).
export default defineConfig(({ mode }) => ({
  root: "src/web",
  base: "./",
  publicDir: "../../public",
  plugins: [react()],
  define: {
    __STANDALONE__: JSON.stringify(mode === "standalone"),
  },
  build: {
    outDir: mode === "standalone" ? "../../dist/preview" : "../../dist/web",
    emptyOutDir: true,
    // The preview ships as one self-contained page.
    rollupOptions: mode === "standalone" ? { output: { inlineDynamicImports: true } } : undefined,
  },
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
}));
