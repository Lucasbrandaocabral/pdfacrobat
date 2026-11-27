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

  const lists = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const ticketFile = path.join(dir, "impressao-preferencias.xml");
  const pending = path.join(dir, "impressao-preferencias.json");

  // apply() com a opção atual de um recurso do app: grava, anota e desfaz.
  const feature = ["media", "quality", "resolution"].find((k) => lists(before[k]).length > 0);
  check(Boolean(feature), `o driver tem opções de ${feature}`);
  if (feature) {
    const applied = await winprint.apply(PRINTER, { [feature]: lists(before[feature])[0].key });
    check(Boolean(applied), `apply() grava ${feature}`);
    check(fs.existsSync(pending), "anota que há preferências a desfazer");
    await winprint.restore(applied);
    check(!fs.existsSync(pending), "restore() desfaz e não sobra nada a desfazer");
  }

  // Trocar de verdade: a orientação, que nesta impressora tem duas opções.
  const EXTRA = "PageOrientation";
  const read2 = () => winprint._run({ PDFA_ACTION: "caps", PDFA_PRINTER: PRINTER, PDFA_EXTRA: EXTRA });
  const start = await read2();
  const options = lists(start.extra);
  console.log("orientação:", JSON.stringify(start.extra), "atual:", start.current.extra);
  check(options.length > 1, `a orientação tem mais de uma opção (${options.length})`);
  const other = options.find((o) => o.key !== start.current.extra);
  if (other) {
    const set = (choice) => winprint._run({ PDFA_ACTION: "apply", PDFA_PRINTER: PRINTER, PDFA_EXTRA: EXTRA, PDFA_CHOICE: JSON.stringify(choice), PDFA_TICKET_FILE: ticketFile });
    const result = await set({ extra: other.key });
    check(result.changed === 1, `grava a orientação ${other.label}`);
    const during = await read2();
    check(during.current.extra === other.key, `durante a impressão: ${during.current.extra}`);
    await winprint._run({ PDFA_ACTION: "restore", PDFA_PRINTER: PRINTER, PDFA_TICKET_FILE: ticketFile });
    const after = await read2();
    check(after.current.extra === start.current.extra, `depois volta ao que era: ${after.current.extra}`);

    // Fechou no meio: a próxima abertura desfaz.
    await set({ extra: other.key });
    fs.writeFileSync(pending, JSON.stringify({ printer: PRINTER }));
    await winprint.init(dir);
    const reopened = await read2();
    check(reopened.current.extra === start.current.extra && !fs.existsSync(pending), `ao abrir de novo, desfaz o que ficou: ${reopened.current.extra}`);
  }
  const empty = await winprint.apply(PRINTER, { media: "", quality: "", resolution: "" });
  check(empty === null, "sem escolha, não mexe na impressora");
  console.log(fails ? `\n${fails} FALHA(S)` : "\ntudo certo");
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
