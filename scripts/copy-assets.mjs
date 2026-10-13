// Copia recursos de bibliotecas para public/, de onde são servidos em dev e no
// build: PDF.js (mapas de caracteres, fontes padrão, ícones de anotação) e
// Tesseract (OCR offline: worker, núcleo WebAssembly e dados de idioma).
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");
const pub = join(root, "public");

async function copy(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

const pdfjs = join(modules, "pdfjs-dist");
await copy(join(pdfjs, "cmaps"), join(pub, "pdfjs", "cmaps"));
await copy(join(pdfjs, "standard_fonts"), join(pub, "pdfjs", "standard_fonts"));
await copy(join(pdfjs, "web", "images"), join(pub, "pdfjs", "images"));

const tesseract = join(pub, "tesseract");
await copy(join(modules, "tesseract.js", "dist", "worker.min.js"), join(tesseract, "worker.min.js"));
for (const variant of ["lstm", "simd-lstm", "relaxedsimd-lstm"]) {
  const file = `tesseract-core-${variant}.wasm.js`;
  await copy(join(modules, "tesseract.js-core", file), join(tesseract, file));
}
for (const lang of ["por", "eng"]) {
  await copy(
    join(modules, "@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`),
    join(tesseract, "lang", `${lang}.traineddata.gz`),
  );
}
console.log("Recursos do PDF.js e do Tesseract copiados para public/");
