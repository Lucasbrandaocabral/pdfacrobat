// Teste do app Android num emulador (workflow "Testar o app Android").
// Instala o APK assinado (precisa abrir sem travar) e depois o de teste, com
// o WebView depurável, para usar o app de verdade: abre um PDF por "Abrir
// com", assina, salva pelo seletor de arquivos do Android e confere o arquivo
// gravado; também imprime e usa o botão voltar do sistema.
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
const SAVE_BUTTON = { text: /^(save|salvar)$/i };
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
device.setDefaultTimeout(60000);
const sh = async (command) => (await device.shell(command)).toString().trim();
const shot = (name) => device.screenshot({ path: path.join(out, `${name}.png`) });
const dumpScreen = async (name) => {
  await sh("uiautomator dump /sdcard/tela.xml").catch(() => {});
  fs.writeFileSync(path.join(out, `${name}.xml`), await sh("cat /sdcard/tela.xml").catch(() => ""));
};
log("Aparelho:", device.model(), "| Android", await sh("getprop ro.build.version.release"), "| WebView", await sh("dumpsys webviewupdate | grep -m1 'Current WebView package'"));

// PDF de 3 páginas para o teste.
const sample = await PDFDocument.create();
const font = await sample.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 3; n++) sample.addPage([595, 842]).drawText(`Pagina ${n} - teste do app Android`, { x: 72, y: 760, size: 22, font });
const sampleBytes = await sample.save();

// 1) APK assinado, como o publicado: instala e abre sem travar.
await device.installApk(fs.readFileSync(releaseApk));
await sh("logcat -c");
await sh(`am start -W -n ${PKG}/.MainActivity`);
await sleep(10000);
await shot("1-apk-assinado");
const crashes = await sh("logcat -d -b crash");
check("APK assinado instala e abre", Boolean(await sh(`pidof ${PKG}`)) && !crashes.includes(PKG), crashes.slice(0, 400));
await sh(`am force-stop ${PKG}`);
await sh(`pm uninstall ${PKG}`);

// 2) APK de teste: o PDF chega por "Abrir com" (pelo FileProvider do próprio app).
await device.installApk(fs.readFileSync(debugApk));
await device.push(Buffer.from(sampleBytes), "/data/local/tmp/contrato.pdf");
await sh(`run-as ${PKG} mkdir -p cache`);
await sh(`cat /data/local/tmp/contrato.pdf | run-as ${PKG} sh -c 'cat > cache/contrato.pdf'`);
await sh(
  `am start -W -a android.intent.action.VIEW -t application/pdf -d content://${PKG}.fileprovider/my_cache_images/contrato.pdf -n ${PKG}/.MainActivity`,
);
const webview = await device.webView({ pkg: PKG });
const page = await webview.page();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.waitForFunction(() => window.__app?.manager.active?.doc, null, { timeout: 60000 });
await page.waitForSelector(".page canvas");
await sleep(1500);
await shot("2-abrir-com");
check("PDF aberto pelo \"Abrir com\"", (await page.evaluate(() => `${window.__app.manager.active.name} ${window.__app.manager.active.doc.numPages}`)) === "contrato.pdf 3");

const idle = async () => {
  await page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 60000 });
  await sleep(800);
};
const click = async (selector) => {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.click(selector);
};

// 3) Assinar: nome digitado, caixa ajustável, Concluir.
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

// 4) Salvar: abre o seletor do Android; o arquivo gravado precisa ter a assinatura.
await sh("rm -f /sdcard/Download/contrato*.pdf");
await click('.topbar [data-action="save"]');
await device.wait(SAVE_BUTTON);
await sleep(1500);
await shot("4-salvar-como");
await dumpScreen("4-salvar-como");
await device.tap(SAVE_BUTTON);
await page.waitForFunction(() => /salvo/i.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
await shot("5-salvo");
const savedName = (await sh("ls -t /sdcard/Download | grep -m1 -i 'contrato.*pdf'")).trim();
check("Arquivo salvo em Downloads", Boolean(savedName), savedName);
if (savedName) {
  const saved = Buffer.from(await sh(`base64 -w0 '/sdcard/Download/${savedName}'`), "base64");
  fs.writeFileSync(path.join(out, "salvo.pdf"), saved);
  const doc = await PDFDocument.load(saved);
  const xobjects = doc.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"));
  const images = xobjects instanceof PDFDict ? xobjects.keys().filter((k) => xobjects.lookup(k)?.dict?.get(PDFName.of("Subtype")) === PDFName.of("Image")) : [];
  check("PDF salvo é válido e tem a assinatura", doc.getPageCount() === 3 && images.length === 1, `${doc.getPageCount()} páginas, ${images.length} imagem(ns) na página 1`);
  check("Aba passa a apontar para o arquivo salvo", (await page.evaluate(() => window.__app.manager.active.path || "")).startsWith("content://"));
}

// 5) Salvar de novo grava no mesmo arquivo, sem perguntar.
await page.evaluate(() => window.__app.manager.active.setDirty(true));
await click('.topbar [data-action="save"]');
await page.waitForFunction(() => !window.__app.manager.active.dirty, null, { timeout: 30000 });
check("Salvar de novo grava no mesmo arquivo", (await sh("ls /sdcard/Download | grep -c -i 'contrato.*pdf'")) === "1");

// 6) Imprimir abre o serviço de impressão do Android.
await click('.topbar [data-action="print"]');
await device.wait({ pkg: /printspooler/ }, { timeout: 30000 });
await sleep(2500);
await shot("6-imprimir");
check("Imprimir abre a impressão do Android", true);
await device.input.press("Back");
await sleep(1500);
if (!(await sh("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -2")).includes(PKG)) {
  await device.input.press("Back");
  await sleep(1500);
}

// 7) Botão voltar: fecha a janela aberta; sem nada aberto, o app vai para segundo plano.
await click('.tools[data-panel="fill"] [data-action="sign"]');
await sleep(1000);
const dialogOpen = await page.evaluate(() => Boolean(document.querySelector("dialog[open]")));
await device.input.press("Back");
await sleep(1000);
check("Voltar fecha a janela aberta", dialogOpen && (await page.evaluate(() => !document.querySelector("dialog[open]"))));
await page.evaluate(() => window.__app.tools.apply("select"));
await device.input.press("Back");
await sleep(1500);
const focus = await sh("dumpsys window | grep -E 'mCurrentFocus' | head -1");
check("Voltar sem nada aberto deixa o app em segundo plano", !focus.includes(PKG), focus);

check("Sem erros de JavaScript", pageErrors.length === 0, pageErrors.join(" | "));
const crashesAfter = await sh("logcat -d -b crash");
check("Sem travamentos", !crashesAfter.includes(PKG), crashesAfter.slice(0, 400));
fs.writeFileSync(path.join(out, "logcat.txt"), await sh(`logcat -d -v time | grep -i -E "capacitor|chromium|${PKG}|AndroidRuntime" | tail -400`));
await device.close();
log(failures ? `${failures} verificação(ões) falharam.` : "Tudo certo.");
process.exit(failures ? 1 : 0);
