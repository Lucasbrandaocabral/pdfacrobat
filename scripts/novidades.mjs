// Lê o NOVIDADES.md para os workflows:
//   node scripts/novidades.mjs notas 1.11.0  o que mudou na versão (página dela no GitHub)
//   node scripts/novidades.mjs ultima        o número da versão mais nova (versão web)
// Sai com erro quando a versão (ou nenhuma) está no arquivo.
import { readFileSync } from "node:fs";

const lines = readFileSync(new URL("../NOVIDADES.md", import.meta.url), "utf8").split(/\r?\n/);
const versionOf = (line) => /^##\s+v?(\d+\.\d+\.\d+)(?![\d.])/.exec(line.trim())?.[1];
const [command, version] = process.argv.slice(2);

if (command === "ultima") {
  const newest = lines.map(versionOf).find(Boolean);
  if (!newest) process.exit(1);
  console.log(newest);
} else if (command === "notas" && version) {
  const start = lines.findIndex((line) => versionOf(line) === version);
  if (start < 0) process.exit(1);
  const next = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line.trim()));
  const notes = lines
    .slice(start + 1, next < 0 ? lines.length : next)
    .join("\n")
    .trim();
  if (!notes) process.exit(1);
  console.log(notes);
} else {
  console.error("Uso: node scripts/novidades.mjs notas <versão> | ultima");
  process.exit(2);
}
