// Teste do app Android num emulador (workflow "Testar o app Android").
// Instala o APK assinado (precisa abrir sem travar) e depois o de teste, com
// o WebView depurável, para usar o app de verdade: abre um PDF por "Abrir
// com", assina, troca uma linha de texto (com outra fonte) e escreve texto
// novo, salva pelo seletor de arquivos do Android e confere o arquivo
// gravado; também imprime e usa o botão voltar do sistema. Quando um passo
// falha, o log mostra o que estava na tela, e os passos seguintes continuam.
//
// node scripts/android-e2e.mjs <apk assinado> <apk de teste> <pasta de saída>
// A variável PLAYWRIGHT aponta para o pacote playwright instalado à parte.
import { PDFDocument, PDFDict, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import fs from "node:fs";
import path from "node:path";

const playwright = await import(process.env.PLAYWRIGHT || "playwright");
const _android = playwright._android ?? playwright.default._android;
const [releaseApk, debugApk, out = "android-test"] = process.argv.slice(2);
const PKG = "com.lucasbrandaocabral.pdfacrobat";
fs.mkdirSync(out, { recursive: true });

const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (what, ok, detail = "") => {
  log(`${ok ? "OK  " : "FALHOU"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const [device] = await _android.devices();
if (!device) throw new Error("Nenhum emulador conectado.");
device.setDefaultTimeout(30000);
const sh = async (command) => (await device.shell(command)).toString().trim();
const shot = (name) => device.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {});
let page = null;

// A tela é lida com o uiautomator e os toques vão pelo adb ("input tap"): o
// controlador de toque do Playwright disputa o uiautomator e demora a iniciar.
async function screenNodes() {
  await sh("uiautomator dump /sdcard/tela.xml");
  const xml = await sh("cat /sdcard/tela.xml");
  return [...xml.matchAll(/<node [^>]*>/g)].map(([n]) => {
    const [x1, y1, x2, y2] = (/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n) || []).slice(1).map(Number);
    return {
      text: /text="([^"]*)"/.exec(n)?.[1] || "",
      desc: /content-desc="([^"]*)"/.exec(n)?.[1] || "",
      id: /resource-id="([^"]*)"/.exec(n)?.[1] || "",
      pkg: /package="([^"]*)"/.exec(n)?.[1] || "",
      clickable: /clickable="true"/.test(n),
      enabled: /enabled="true"/.test(n),
      center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
    };
  });
}

async function waitForNode(match, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    await dismissOtherAnr();
    const node = (await screenNodes().catch(() => [])).find(match);
    if (node) return node;
    if (Date.now() > end) throw new Error("elemento não apareceu na tela");
    await sleep(1000);
  }
}

const tapNode = (node) => sh(`input tap ${node.center[0]} ${node.center[1]}`);
const pressBack = () => sh("input keyevent KEYCODE_BACK");
const focusedWindow = async () => /mCurrentFocus=.*$/m.exec(await sh("dumpsys window"))?.[0] || "";

// O emulador do CI às vezes mostra "<app do sistema> isn't responding" (o
// launcher, por exemplo) por cima de tudo. Se o aviso não for do nosso app,
// toca em "Wait" e segue; um travamento do próprio app continua sendo falha.
async function dismissOtherAnr() {
  const anr = /Application Not Responding: ([\w.]+)/.exec(await focusedWindow().catch(() => ""));
  if (!anr || anr[1].startsWith(PKG)) return false;
  const wait = (await screenNodes().catch(() => [])).find((n) => n.id === "android:id/aerr_wait" && n.clickable);
  if (!wait) return false;
  log(`   (aviso de travamento de ${anr[1]} fechado com "Wait")`);
  await tapNode(wait);
  await sleep(1500);
  return true;
}

async function waitForFocus(pattern, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    await dismissOtherAnr();
    const focus = await focusedWindow();
    if (pattern.test(focus)) return focus;
    if (Date.now() > end) throw new Error(`janela esperada não apareceu (${focus})`);
    await sleep(1000);
  }
}

/** O que está na tela: janela em foco, textos e botões, estado do app e o logcat. */
async function describeScreen(name) {
  await shot(name);
  log(`   tela "${name}": ${await focusedWindow()}`);
  const nodes = (await screenNodes().catch(() => [])).filter((n) => n.text || n.desc || (n.clickable && n.id));
  for (const n of nodes.slice(0, 60)) {
    log(`     - ${n.pkg} | id=${n.id || "-"} | text="${n.text}" | desc="${n.desc}"${n.clickable ? " | clicável" : ""}${n.enabled ? "" : " | desativado"}`);
  }
  if (page) {
    const state = await page
      .evaluate(() => ({
        toast: document.getElementById("toast")?.textContent,
        busy: !document.getElementById("busy").hidden && document.getElementById("busy-text")?.textContent,
        dialog: document.querySelector("dialog[open]")?.id,
        tool: window.__app?.tools.tool,
      }))
      .catch((e) => ({ erro: e.message }));
    log("   app:", JSON.stringify(state));
  }
  // Filtrado aqui: o Capacitor de teste registra os arquivos inteiros no logcat.
  const logcat = (await sh("logcat -d -v brief").catch(() => ""))
    .split("\n")
    .filter((line) => /Capacitor\/Console|NativeFiles|ActivityTaskManager: START|AndroidRuntime|chromium/.test(line))
    .slice(-25)
    .map((line) => `     | ${line.slice(0, 300)}`);
  if (logcat.length) log(logcat.join("\n"));
}

/** Executa um passo; se der erro, registra a falha, mostra a tela e segue. */
async function step(name, fn) {
  try {
    await dismissOtherAnr();
    await fn();
  } catch (error) {
    check(name, false, error.message.split("\n")[0]);
    await describeScreen(`erro-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`);
  }
}

log("Aparelho:", device.model(), "| Android", await sh("getprop ro.build.version.release"), "|", await sh("dumpsys webviewupdate | grep -m1 'Current WebView package'"));

// PDF de 3 páginas para o teste.
const sample = await PDFDocument.create();
const font = await sample.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 3; n++) sample.addPage([595, 842]).drawText(`Pagina ${n} - teste do app Android`, { x: 72, y: 760, size: 22, font });
const sampleBytes = await sample.save();

// 1) APK assinado, como o publicado: instala e abre sem travar.
await step("APK assinado instala e abre", async () => {
  await device.installApk(fs.readFileSync(releaseApk));
  await sh("logcat -c");
  await sh(`am start -W -n ${PKG}/.MainActivity`);
  await sleep(10000);
  await shot("1-apk-assinado");
  const crashes = await sh("logcat -d -b crash");
  check("APK assinado instala e abre", Boolean(await sh(`pidof ${PKG}`)) && !crashes.includes(PKG), crashes.slice(0, 400));
});
await sh(`am force-stop ${PKG}`);
await sh(`pm uninstall ${PKG}`);

// 2) APK de teste: o PDF chega por "Abrir com" (pelo FileProvider do próprio app).
await device.installApk(fs.readFileSync(debugApk));
await device.push(Buffer.from(sampleBytes), "/data/local/tmp/contrato.pdf");
await sh(`run-as ${PKG} mkdir -p cache`);
await sh(`cat /data/local/tmp/contrato.pdf | run-as ${PKG} sh -c 'cat > cache/contrato.pdf'`);
await sh("logcat -c");
await sh(
  `am start -W -a android.intent.action.VIEW -t application/pdf -d content://${PKG}.fileprovider/my_cache_images/contrato.pdf -n ${PKG}/.MainActivity`,
);
const webview = await device.webView({ pkg: PKG }, { timeout: 60000 });
page = await webview.page();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const idle = async () => {
  await page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 60000 });
  await sleep(800);
};
const click = async (selector) => {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.click(selector);
};

await step('PDF aberto pelo "Abrir com"', async () => {
  await page.waitForFunction(() => window.__app?.manager.active?.doc, null, { timeout: 60000 });
  await page.waitForSelector(".page canvas");
  await sleep(1500);
  await shot("2-abrir-com");
  const opened = await page.evaluate(() => `${window.__app.manager.active.name} ${window.__app.manager.active.doc.numPages}`);
  check('PDF aberto pelo "Abrir com"', opened === "contrato.pdf 3", opened);
});

// 3) Assinar: nome digitado, caixa ajustável, Concluir.
await step("Assinatura aplicada", async () => {
  await page.evaluate(() => localStorage.setItem("authorName", "Maria Teste"));
  await click('[data-category="fill"]');
  await click('.tools[data-panel="fill"] [data-action="sign"]');
  await page.waitForSelector("#signature-dialog[open]");
  await sleep(500);
  await page.fill("#signature-name", "Maria Teste");
  await page.click('#signature-dialog button[value="ok"]');
  await page.waitForFunction(() => window.__app.tools.tool === "sign");
  const box = await page.locator('.page[data-page-number="1"] .canvasWrapper').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.5, 400));
  await page.waitForSelector(".image-box");
  await shot("3-assinatura-na-caixa");
  await page.click(".float-bar button.primary");
  await idle();
  check("Assinatura aplicada", (await page.evaluate(() => window.__app.manager.active.dirty)) === true);
});

// 3b) Texto: troca uma linha (com outra fonte do catálogo) e escreve texto novo.
/** Toca no ponto (x, y) do PDF na página n. */
const tapPdf = async (n, x, y) => {
  const [sx, sy] = await page.evaluate(
    ({ n, x, y }) => {
      const view = window.__app.manager.active.pageView(n);
      view.div.scrollIntoView({ block: "center" });
      const box = view.div.querySelector(".canvasWrapper").getBoundingClientRect();
      const [vx, vy] = view.viewport.convertToViewportPoint(x, y);
      return [box.left + vx, box.top + vy];
    },
    { n, x, y },
  );
  await sleep(500);
  await page.mouse.click(sx, sy);
};
const pageText = (n) =>
  page.evaluate(async (n) => {
    const p = await window.__app.manager.active.doc.getPage(n);
    return (await p.getTextContent()).items.map((i) => i.str).join(" ");
  }, n);
await step("Texto editado e adicionado", async () => {
  await click('[data-category="edit"]');
  await click('.tools[data-panel="edit"] [data-tool="edit"]');
  await tapPdf(1, 120, 767);
  await page.waitForSelector(".text-editor", { timeout: 15000 });
  await sleep(800);
  await page.keyboard.type("Pagina editada no Android");
  await page.click(".text-bar .font-button");
  await page.waitForSelector(".font-picker");
  await page.fill(".font-picker .font-search", "lobster");
  await page.click(".font-picker .font-option >> nth=0");
  await sleep(800);
  await shot("3b-editando-texto");
  await page.click(".text-bar .btn.primary");
  await idle();
  await click('.tools[data-panel="edit"] [data-tool="addtext"]');
  await tapPdf(1, 100, 600);
  await page.waitForSelector(".text-editor", { timeout: 15000 });
  await page.keyboard.type("Texto novo no celular");
  await page.click(".text-bar .btn.primary");
  await idle();
  await shot("3c-texto-aplicado");
  const text = await pageText(1);
  check("Texto editado e adicionado", text.includes("Pagina editada no Android") && text.includes("Texto novo no celular") && !text.includes("teste do app Android"), text);
  await page.evaluate(() => window.__app.tools.apply("select"));
});

// 4) Salvar: abre o seletor do Android; o arquivo gravado precisa ter a assinatura.
let savedName = "";
await step("Salvar pelo seletor do Android", async () => {
  await sh("rm -f /sdcard/Download/contrato*.pdf");
  await sh("logcat -c");
  await click('.topbar [data-action="save"]');
  const save = await waitForNode((n) => /^(save|salvar)$/i.test(n.text) && n.clickable && n.enabled, 30000);
  await describeScreen("4-salvar-como");
  await tapNode(save);
  await page.waitForFunction(() => /salvo/i.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
  await shot("5-salvo");
  savedName = (await sh("ls -t /sdcard/Download | grep -m1 -i 'contrato.*pdf'")).trim();
  check("Arquivo salvo em Downloads", Boolean(savedName), savedName);
  const saved = Buffer.from(await sh(`base64 -w0 '/sdcard/Download/${savedName}'`), "base64");
  fs.writeFileSync(path.join(out, "salvo.pdf"), saved);
  const doc = await PDFDocument.load(saved);
  const xobjects = doc.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"));
  const images = xobjects instanceof PDFDict ? xobjects.keys().filter((k) => xobjects.lookup(k)?.dict?.get(PDFName.of("Subtype")) === PDFName.of("Image")) : [];
  check("PDF salvo é válido e tem a assinatura", doc.getPageCount() === 3 && images.length === 1, `${doc.getPageCount()} páginas, ${images.length} imagem(ns) na página 1`);
  const fonts = doc.getPage(0).node.Resources()?.lookup(PDFName.of("Font"));
  const fontNames = fonts instanceof PDFDict ? fonts.keys().map((k) => fonts.lookup(k)?.lookup?.(PDFName.of("BaseFont"))?.decodeText?.() || "") : [];
  check("PDF salvo tem a fonte escolhida no texto", fontNames.some((name) => /Lobster/.test(name)), fontNames.join(", "));
  check("Aba passa a apontar para o arquivo salvo", (await page.evaluate(() => window.__app.manager.active.path || "")).startsWith("content://"));
});

// 5) Salvar de novo grava no mesmo arquivo, sem perguntar.
if (savedName) {
  await step("Salvar de novo grava no mesmo arquivo", async () => {
    await page.evaluate(() => window.__app.manager.active.setDirty(true));
    await click('.topbar [data-action="save"]');
    await page.waitForFunction(() => !window.__app.manager.active.dirty, null, { timeout: 30000 });
    check("Salvar de novo grava no mesmo arquivo", (await sh("ls /sdcard/Download | grep -c -i 'contrato.*pdf'")) === "1");
  });
}

// Volta para o app se uma tela do sistema ficou por cima.
async function backToApp() {
  await dismissOtherAnr();
  for (let i = 0; i < 3 && !(await focusedWindow()).includes(PKG); i++) {
    await pressBack();
    await sleep(1500);
  }
}
await backToApp();

// 6) Imprimir: a janela de impressão do app (duas páginas por folha, com a
// visualização) e depois o serviço de impressão do Android.
await step("Janela de impressão do app", async () => {
  await click('.topbar [data-action="print"]');
  await page.waitForSelector("#print-dialog[open]", { timeout: 15000 });
  await click('#print-dialog [data-mode="multiple"]');
  await page.selectOption('#print-dialog [name="perSheet"]', "2");
  await page.waitForFunction(() => /Folha 1 de 2/.test(document.querySelector("#print-dialog .print-count").textContent), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#print-dialog .print-sheet").width > 50, null, { timeout: 30000 });
  await shot("6-janela-de-impressao");
  const count = await page.evaluate(() => document.querySelector("#print-dialog .print-count").textContent);
  check("Janela de impressão do app", true, count);
});
await step("Imprimir abre a impressão do Android", async () => {
  await click('#print-dialog button[value="ok"]');
  const focus = await waitForFocus(/printspooler/, 30000);
  await sleep(2500);
  await describeScreen("6-imprimir");
  check("Imprimir abre a impressão do Android", true, focus);
});
await backToApp();

// 7) Dividir PDF: a tela de miniaturas abre, mostra quantos arquivos e o voltar do Android a fecha.
await step("Tela Dividir PDF", async () => {
  await click('[data-category="pages"]');
  await click('.tools[data-panel="pages"] [data-action="split"]');
  await page.waitForSelector("#split-tool[open]", { timeout: 15000 });
  await click('#split-tool [data-tab="ranges"]');
  await click('#split-tool [data-mode="fixed"]');
  await page.fill('#split-tool [name="every"]', "1");
  await page.waitForFunction(() => /3 PDFs serão criados/.test(document.querySelector("#split-tool .tool-info").textContent), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#split-tool .page-thumb[src]"), null, { timeout: 20000 });
  await shot("7-dividir");
  const info = await page.evaluate(() => document.querySelector("#split-tool .tool-info").textContent);
  await pressBack();
  await sleep(1000);
  check("Tela Dividir PDF", await page.evaluate(() => !document.querySelector("#split-tool[open]")), info);
});

// 8) Botão voltar: fecha a janela aberta; sem nada aberto, o app vai para segundo plano.
await step("Voltar fecha a janela aberta", async () => {
  await page.evaluate(() => window.__app.tools.apply("select"));
  // Iniciais ainda não foram criadas: abre a janela (a assinatura já está salva).
  await click('[data-category="fill"]');
  await click('.tools[data-panel="fill"] [data-action="sign-initials"]');
  await page.waitForSelector("dialog[open]", { timeout: 10000 });
  await pressBack();
  await sleep(1000);
  check("Voltar fecha a janela aberta", await page.evaluate(() => !document.querySelector("dialog[open]")));
});
await step("Voltar sem nada aberto deixa o app em segundo plano", async () => {
  await page.evaluate(() => {
    window.__app.tools.clearEdit();
    window.__app.tools.apply("select");
  });
  await pressBack();
  await sleep(1500);
  const focus = await focusedWindow();
  check("Voltar sem nada aberto deixa o app em segundo plano", !focus.includes(PKG), focus);
});

check("Sem erros de JavaScript", pageErrors.length === 0, pageErrors.join(" | "));
const crashesAfter = await sh("logcat -d -b crash");
check("Sem travamentos do app", !crashesAfter.includes(`(${PKG})`) && !crashesAfter.includes(`Process: ${PKG}`), crashesAfter.slice(0, 400));
await device.close();
log(failures ? `${failures} verificação(ões) falharam.` : "Tudo certo.");
process.exit(failures ? 1 : 0);
