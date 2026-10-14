import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  // Caminhos relativos para que o build funcione dentro do Electron e em subpastas (GitHub Pages).
  base: "./",
  define: {
    // Usada pelo app Android para saber se há versão nova.
    __APP_VERSION__: JSON.stringify(version),
  },
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
