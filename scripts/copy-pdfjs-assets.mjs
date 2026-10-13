// Copia recursos do PDF.js (mapas de caracteres, fontes padrão e ícones de
// anotação) para public/pdfjs, de onde são servidos em dev e no build.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");

await mkdir(dest, { recursive: true });
for (const dir of ["cmaps", "standard_fonts"]) {
  await cp(join(src, dir), join(dest, dir), { recursive: true });
}
await cp(join(src, "web", "images"), join(dest, "images"), { recursive: true });
console.log("Recursos do PDF.js copiados para public/pdfjs");
