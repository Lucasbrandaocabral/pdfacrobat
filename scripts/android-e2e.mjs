// Teste do app Android num emulador (workflow "Testar o app Android").
// Instala o APK assinado (precisa abrir sem travar) e depois o de teste, com
// o WebView depurável, para usar o app de verdade: abre um PDF por "Abrir
// com", assina, salva pelo seletor de arquivos do Android e confere o arquivo
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
// O Playwright manda só o texto da expressão para o Android (sem o "i"), por
// isso as variações de maiúsculas estão escritas.
const SAVE_TEXT = /^(Save|SAVE|save|Salvar|SALVAR|salvar)$/;
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

/** O que está na tela: janela em foco e os textos/botões visíveis (uiautomator). */
async function describeScreen(name) {
  await shot(name);
  const focus = await sh("dumpsys window | grep -m1 mCurrentFocus").catch(() => "");
  await sh("uiautomator dump /sdcard/tela.xml").catch(() => {});
  const xml = await sh("cat /sdcard/tela.xml").catch(() => "");
  fs.writeFileSync(path.join(out, `${name}.xml`), xml);
  const nodes = [...xml.matchAll(/<node [^>]*>/g)]
    .map((m) => m[0])
    .map((n) => ({
      text: /text="([^"]*)"/.exec(n)?.[1],
      desc: /content-desc="([^"]*)"/.exec(n)?.[1],
      id: /resource-id="([^"]*)"/.exec(n)?.[1],
      pkg: /package="([^"]*)"/.exec(n)?.[1],
      clickable: /clickable="true"/.test(n),
      enabled: /enabled="true"/.test(n),
    }))
    .filter((n) => n.text || n.desc || (n.clickable && n.id));
  log(`   tela "${name}": ${focus}`);
  for (const n of nodes.slice(0, 60)) {
    log(`     - ${n.pkg} | id=${n.id || "-"} | text="${n.text || ""}" | desc="${n.desc || ""}"${n.clickable ? " | clicável" : ""}${n.enabled ? "" : " | desativado"}`);
  }
  if (page) {
    const state = await page
      .evaluate(() => ({
        toast: document.getElementById("toast")?.textContent,
        busy: !document.getElementById("busy").hidden && document.getElementById("busy-text")?.textContent,
        dialog: document.querySelector("dialog[open]")?.id,
      }))
      .catch((e) => ({ erro: e.message }));
    log("   app:", JSON.stringify(state));
  }
  const logcat = await sh(`logcat -d -v brief | grep -i -E "Capacitor|NativeFiles|ActivityTaskManager: START|AndroidRuntime" | tail -25`).catch(() => "");
  if (logcat) log(logcat.replace(/^/gm, "     | "));
}

/** Executa um passo; se der erro, registra a falha, mostra a tela e segue. */
async function step(name, fn) {
  try {
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

// 4) Salvar: abre o seletor do Android; o arquivo gravado precisa ter a assinatura.
let savedName = "";
await step("Salvar pelo seletor do Android", async () => {
  await sh("rm -f /sdcard/Download/contrato*.pdf");
  await sh("logcat -c");
  await click('.topbar [data-action="save"]');
  await sleep(6000);
  await describeScreen("4-salvar-como");
  const save =
    (await device.wait({ text: SAVE_TEXT }, { timeout: 5000 }).then(() => ({ text: SAVE_TEXT })).catch(() => null)) ||
    (await device.wait({ desc: SAVE_TEXT }, { timeout: 5000 }).then(() => ({ desc: SAVE_TEXT })).catch(() => null));
  if (!save) throw new Error("botão Salvar do seletor não apareceu");
  await device.tap(save);
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
  for (let i = 0; i < 3 && !(await sh("dumpsys window | grep -m1 mCurrentFocus")).includes(PKG); i++) {
    await device.input.press("Back");
    await sleep(1500);
  }
}
await backToApp();

// 6) Imprimir abre o serviço de impressão do Android.
await step("Imprimir abre a impressão do Android", async () => {
  await click('.topbar [data-action="print"]');
  await device.wait({ pkg: /printspooler/ }, { timeout: 30000 });
  await sleep(2500);
  await shot("6-imprimir");
  check("Imprimir abre a impressão do Android", true);
});
await backToApp();

// 7) Botão voltar: fecha a janela aberta; sem nada aberto, o app vai para segundo plano.
await step("Voltar fecha a janela aberta", async () => {
  await page.evaluate(() => window.__app.tools.apply("select"));
  await click('.tools[data-panel="fill"] [data-action="sign"]');
  await page.waitForSelector("dialog[open]", { timeout: 10000 });
  await device.input.press("Back");
  await sleep(1000);
  check("Voltar fecha a janela aberta", await page.evaluate(() => !document.querySelector("dialog[open]")));
});
await step("Voltar sem nada aberto deixa o app em segundo plano", async () => {
  await page.evaluate(() => {
    window.__app.tools.clearEdit();
    window.__app.tools.apply("select");
  });
  await device.input.press("Back");
  await sleep(1500);
  const focus = await sh("dumpsys window | grep -m1 mCurrentFocus");
  check("Voltar sem nada aberto deixa o app em segundo plano", !focus.includes(PKG), focus);
});

check("Sem erros de JavaScript", pageErrors.length === 0, pageErrors.join(" | "));
const crashesAfter = await sh("logcat -d -b crash");
check("Sem travamentos", !crashesAfter.includes(PKG), crashesAfter.slice(0, 400));
await device.close();
log(failures ? `${failures} verificação(ões) falharam.` : "Tudo certo.");
process.exit(failures ? 1 : 0);
