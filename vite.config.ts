import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "frontend/index.html"),
        app: resolve(import.meta.dirname, "frontend/app.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3001",
    },
  },
});
