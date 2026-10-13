import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Caminhos relativos para que o build funcione dentro do Electron e em subpastas (GitHub Pages).
  base: "./",
  resolve: {
    alias: {
      // Rotinas internas de criptografia do pdf-lib, usadas para validar a senha de permissões.
      "cantoo-crypto": fileURLToPath(new URL("./node_modules/@cantoo/pdf-lib/es/core/crypto.js", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});
