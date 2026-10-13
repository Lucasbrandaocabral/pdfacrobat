import { defineConfig } from "vite";

export default defineConfig({
  // Caminhos relativos para que o build funcione via file:// dentro do Electron.
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});
