// Teste das preferências da impressora no Windows (electron/winprint.cjs),
// com a impressora "Microsoft Print to PDF", que todo Windows tem: lê as
// opções do driver, grava uma diferente da atual, confere que mudou e que
// volta ao que era.  node scripts/impressora-windows.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const winprint = require("../electron/winprint.cjs");

const PRINTER = process.argv[2] || "Microsoft Print to PDF";
let fails = 0;
const check = (ok, msg) => {
  console.log(ok ? "ok    " : "FALHOU", msg);
  if (!ok) fails++;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winprint-"));
  await winprint.init(dir);
  const read = () => winprint._run({ PDFA_ACTION: "caps", PDFA_PRINTER: PRINTER });
  const before = await read();
  console.log(JSON.stringify(before, null, 1).slice(0, 3000));
  check(before.ok, "lê as opções do driver");
  const caps = await winprint.capabilities(PRINTER);
  check(caps && Array.isArray(caps.media) && Array.isArray(caps.resolution), "capabilities() devolve as listas");

  // Uma opção diferente da atual, no primeiro recurso que tiver mais de uma.
  const lists = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const feature = ["media", "quality", "resolution"].find((k) => lists(before[k]).length > 1);
  check(Boolean(feature), `o driver tem um recurso com mais de uma opção (${feature})`);
  if (feature) {
    const other = lists(before[feature]).find((o) => o.key !== before.current[feature]);
    const applied = await winprint.apply(PRINTER, { [feature]: other.key });
    check(Boolean(applied), `grava ${feature} = ${other.label}`);
    check(fs.existsSync(path.join(dir, "impressao-preferencias.json")), "anota que há preferências a desfazer");
    const during = await read();
    check(during.current[feature] === other.key, `durante a impressão: ${during.current[feature]}`);
    await winprint.restore(applied);
    const after = await read();
    check(after.current[feature] === before.current[feature], `depois volta ao que era: ${after.current[feature]}`);
    check(!fs.existsSync(path.join(dir, "impressao-preferencias.json")), "nada mais a desfazer");

    // Fechou no meio: a próxima abertura desfaz.
    await winprint.apply(PRINTER, { [feature]: other.key });
    await winprint.init(dir);
    const reopened = await read();
    check(reopened.current[feature] === before.current[feature], `ao abrir de novo, desfaz o que ficou: ${reopened.current[feature]}`);
  }
  const empty = await winprint.apply(PRINTER, { media: "", quality: "", resolution: "" });
  check(empty === null, "sem escolha, não mexe na impressora");
  console.log(fails ? `\n${fails} FALHA(S)` : "\ntudo certo");
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
