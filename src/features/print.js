// Janela de impressão do próprio app, como a do Acrobat: impressora e cópias,
// páginas, tamanho e manuseio das páginas (tamanho, pôster, várias por folha
// e livreto), papel, orientação, comentários e formulários, com a
// visualização de cada folha. As folhas formam um PDF novo (imposition.js):
// no app desktop ele vai direto para a impressora; no Android, para o serviço
// de impressão do sistema; no navegador, para a janela de impressão dele.
import { PDFDocument } from "@cantoo/pdf-lib";
import { LOAD_OPTIONS, pdfjsLib } from "../pdfjs.js";
import { $, $$, UserError, baseName, debounce, el, formValues, openDialog, parsePageRange, setBusy, toast } from "../ui.js";
import { Perm } from "../pdf/security.js";
import { PAPERS, choosePages, pageInfo, planSheets, printSource, renderSheets } from "../pdf/imposition.js";
import * as platform from "../platform.js";

const STORAGE_KEY = "impressao";
// Lembradas de uma impressão para a outra (as páginas e as cópias, não).
const REMEMBERED = [
  "printer",
  "grayscale",
  "collate",
  "duplex",
  "mode",
  "sizing",
  "scale",
  "tileScale",
  "overlap",
  "cutMarks",
  "labels",
  "largeOnly",
  "perSheet",
  "cols",
  "rows",
  "order",
  "borders",
  "autoRotate",
  "bookletSides",
  "binding",
  "bookletRotate",
  "paper",
  "orientation",
  "annotations",
];
// Valores que voltam ao padrão a cada vez que a janela abre.
const FRESH = { range: "all", pages: "", subset: "all", reverse: false, copies: 1, sheetFrom: 1, sheetTo: "" };
const PLATFORM = platform.isDesktop ? "desktop" : platform.isAndroid ? "android" : "web";

let dialog = null;
let form = null;
let session = null;
let browserPrint = null;

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function remember(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(REMEMBERED.filter((k) => k in values).map((k) => [k, values[k]]))));
  } catch {
    // Sem armazenamento: as opções valem só desta vez.
  }
}

function restore(values) {
  for (const element of form.elements) {
    if (!element.name || !(element.name in values)) continue;
    const value = values[element.name];
    if (element.type === "checkbox") element.checked = Boolean(value);
    else if (element.type === "radio") element.checked = element.value === value;
    else if (element.tagName !== "SELECT" || [...element.options].some((o) => o.value === String(value))) element.value = value;
  }
}

function setup() {
  if (dialog) return;
  dialog = $("#print-dialog");
  form = $("form", dialog);
  form.elements.paper.append(...Object.entries(PAPERS).map(([id, paper]) => el("option", { value: id, text: paper.label })));
  for (const node of $$("[data-only]", dialog)) node.hidden = !node.dataset.only.split(" ").includes(PLATFORM);
  for (const button of $$("[data-mode]", dialog)) button.addEventListener("click", () => setMode(button.dataset.mode));
  for (const button of $$("[data-sheet]", dialog)) button.addEventListener("click", () => showSheet(session.sheet + Number(button.dataset.sheet)));
  $("[data-print-pdf]", dialog).addEventListener("click", () => {
    if (validate()) dialog.close("pdf");
  });
  form.addEventListener("input", onInput);
  form.addEventListener("change", onInput);
  form.addEventListener("submit", (event) => {
    if (event.submitter?.value === "ok" && !validate()) event.preventDefault();
  });
  dialog.addEventListener("keydown", (event) => {
    // Ctrl+P com a janela aberta imprime, como no Acrobat.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
      // Sem chegar ao atalho geral, que abriria a janela de novo.
      event.preventDefault();
      event.stopPropagation();
      form.requestSubmit(form.querySelector('button[value="ok"]'));
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      // Enter num campo só atualiza a visualização (senão acionaria o Cancelar).
      event.preventDefault();
      scheduleUpdate();
    }
  });
  window.addEventListener("resize", debounce(() => session && drawPreview(), 200));
}

/** Abre a janela de impressão do documento ativo. */
export async function print(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  if (!(await app.guard(tab, Perm.PRINT, "imprimir"))) return;
  setup();
  const saved = loadSaved();
  restore({ ...saved, ...FRESH });
  session = createSession(tab);
  setMode(form.elements.mode.value);
  listPrinters(saved.printer);
  const confirmed = await openDialog(dialog, { focus: 'button[value="ok"]' });
  const s = session;
  session = null;
  const action = confirmed ? "print" : dialog.returnValue === "pdf" ? "pdf" : null;
  if (!action) return;
  remember(formValues(form));
  if (action === "pdf") await app.run("Gerando o PDF das folhas…", () => saveSheets(s));
  else await app.run("Preparando impressão…", () => printSheets(s));
}

function createSession(tab) {
  const s = { tab, current: tab.viewer.currentPageNumber - 1, sheet: 0, token: 0, plan: null, values: null, cache: null };
  // Documento protegido: as folhas são montadas a partir da cópia sem a senha.
  s.bytes = tab.encrypted ? tab.loadEditable().then((doc) => doc.save()) : tab.currentBytes();
  // O documento preparado para imprimir muda com a opção de comentários e
  // formulários. PDF que o pdf-lib não consegue montar: as folhas usam a
  // imagem de cada página (s.raster).
  s.source = (annotations) => {
    const key = s.raster ? "raster" : annotations;
    if (s.cache?.key !== key) s.cache = { key, doc: s.raster ? rasterSource(tab.doc) : s.bytes.then((bytes) => printSource(bytes, annotations)) };
    return s.cache.doc;
  };
  s.info = s
    .source(form.elements.annotations.value)
    .catch((err) => fallBack(s, err))
    .then(pageInfo);
  s.info.catch((err) => {
    console.error(err);
    if (session === s) previewMessage("Não foi possível preparar o documento para imprimir.");
  });
  return s;
}

function fallBack(s, err) {
  if (!s.raster) {
    console.warn("Impressão a partir da imagem das páginas:", err);
    s.raster = true;
  }
  return s.source();
}

/** PDF das folhas `indices` do plano (todas, se omitido). */
async function sheetsPdf(s, plan, indices) {
  const raster = s.raster;
  try {
    return await renderSheets(await s.source(s.values.annotations), plan, indices);
  } catch (err) {
    if (raster) throw err;
    return renderSheets(await fallBack(s, err), plan, indices);
  }
}

async function rasterSource(pdf) {
  const doc = await PDFDocument.create();
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 150 / 72 });
    const canvas = el("canvas", { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, intent: "print", annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    // O pdf-lib só grava a imagem ao salvar, e este documento não é salvo.
    await image.embed();
    doc.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
  }
  return doc;
}

async function listPrinters(saved) {
  if (PLATFORM !== "desktop") return;
  const select = form.elements.printer;
  const printers = await platform.listPrinters();
  const standard = printers.find((p) => p.isDefault);
  select.replaceChildren(
    el("option", { value: "", text: standard ? `Impressora padrão (${standard.displayName})` : "Impressora padrão do sistema" }),
    ...printers.map((p) => el("option", { value: p.name, text: p.displayName })),
  );
  if (printers.some((p) => p.name === saved)) select.value = saved;
}

// ---- Opções ----

function setMode(mode) {
  if (!["size", "poster", "multiple", "booklet"].includes(mode)) mode = "size";
  form.elements.mode.value = mode;
  for (const button of $$("[data-mode]", dialog)) {
    button.classList.toggle("active", button.dataset.mode === mode);
    button.setAttribute("aria-selected", String(button.dataset.mode === mode));
  }
  for (const pane of $$("[data-pane]", dialog)) pane.hidden = pane.dataset.pane !== mode;
  suggestDuplex();
  refreshControls();
  scheduleUpdate();
}

function refreshControls() {
  const booklet = form.elements.mode.value === "booklet";
  // No livreto a ordem das páginas e a orientação da folha são as do próprio livreto.
  for (const name of ["subset", "reverse", "orientation"]) form.elements[name].disabled = booklet;
  $(".print-custom-grid", dialog).hidden = form.elements.perSheet.value !== "custom";
}

/** Livreto em frente e verso: a folha vira na borda curta. */
function suggestDuplex() {
  if (PLATFORM !== "desktop" || form.elements.mode.value !== "booklet") return;
  const duplex = form.elements.duplex;
  if (form.elements.bookletSides.value !== "both") duplex.value = "simplex";
  else if (duplex.value === "simplex") duplex.value = "shortEdge";
}

function onInput(event) {
  if (!session) return;
  const { name } = event.target;
  if (name === "pages") form.elements.range.value = "pages";
  if (name === "scale") form.elements.sizing.value = "custom";
  if (name === "bookletSides") suggestDuplex();
  if (name === "grayscale") $(".print-sheet", dialog).classList.toggle("gray", form.elements.grayscale.checked);
  // Impressora, cópias e frente e verso não mudam as folhas.
  if (["printer", "copies", "collate", "duplex", "grayscale"].includes(name)) return;
  refreshControls();
  scheduleUpdate();
}

const number = (value, fallback, min, max) => {
  const n = Number(value);
  return value === "" || !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, n));
};

/** Lê a janela. Lança UserError se as páginas pedidas não fazem sentido. */
function readForm() {
  const v = formValues(form);
  const { tab } = session;
  const total = tab.doc.numPages;
  let indices;
  if (v.range === "current") indices = [session.current];
  else if (v.range === "pages") {
    if (!v.pages.trim()) throw new UserError("Digite as páginas a imprimir, por exemplo 1-3, 5.");
    indices = parsePageRange(v.pages, total);
  } else indices = [...Array(total).keys()];
  const booklet = v.mode === "booklet";
  indices = choosePages(indices, booklet ? {} : { subset: v.subset, reverse: v.reverse });
  if (!indices.length) throw new UserError(`Não há páginas ${v.subset === "even" ? "pares" : "ímpares"} entre as escolhidas.`);
  const layout = {
    mode: v.mode,
    paper: PAPERS[v.paper] ? v.paper : "a4",
    orientation: v.orientation,
    sizing: v.sizing,
    scale: number(v.scale, 100, 1, 1000),
    tileScale: number(v.tileScale, 100, 1, 1000),
    overlap: number(v.overlap, 0, 0, 10),
    cutMarks: v.cutMarks,
    labels: v.labels,
    largeOnly: v.largeOnly,
    perSheet: v.perSheet === "custom" ? "custom" : Number(v.perSheet),
    cols: number(v.cols, 2, 1, 10),
    rows: number(v.rows, 2, 1, 10),
    order: v.order,
    borders: v.borders,
    autoRotate: booklet ? v.bookletRotate : v.autoRotate,
    bookletSides: v.bookletSides,
    binding: v.binding,
    sheetFrom: number(v.sheetFrom, 1, 1, 99999),
    sheetTo: number(v.sheetTo, 0, 1, 99999),
    fileName: tab.name,
  };
  return { ...v, copies: number(v.copies, 1, 1, 999), indices, layout };
}

function validate() {
  try {
    session.values = readForm();
    showProblem(null);
    return true;
  } catch (err) {
    showProblem(err.userMessage || err.message);
    return false;
  }
}

function showProblem(message) {
  const box = $(".print-error", dialog);
  box.textContent = message || "";
  box.hidden = !message;
}

// ---- Visualização ----

const scheduleUpdate = debounce(() => update(), 120);

async function update() {
  const s = session;
  if (!s || !validate()) return;
  const info = await s.info.catch(() => null);
  if (s !== session || !info) return;
  s.plan = planSheets(s.values.indices.map((i) => info[i]), s.values.layout);
  // Outro modo ou outras páginas: volta para a primeira folha.
  const key = `${s.values.layout.mode} ${s.values.indices.join(",")}`;
  if (key !== s.planKey || s.sheet >= s.plan.sheets.length) s.sheet = 0;
  s.planKey = key;
  showSummary();
  drawPreview();
}

function showSheet(index) {
  const s = session;
  if (!s?.plan || index < 0 || index >= s.plan.sheets.length) return;
  s.sheet = index;
  showSummary();
  drawPreview();
}

const cm = (pt) => (pt / (72 / 2.54)).toFixed(1).replace(".", ",").replace(",0", "");

function showSummary() {
  const { plan, values, sheet: k } = session;
  const sheets = plan.sheets;
  const sheet = sheets[k];
  const booklet = values.layout.mode === "booklet";
  let count = sheets.length ? `Folha ${k + 1} de ${sheets.length}` : "Nenhuma folha";
  if (booklet && sheet) count = `Folha ${sheet.sheet}, ${sheet.side === "front" ? "frente" : "verso"} (${k + 1} de ${sheets.length})`;
  $(".print-count", dialog).textContent = count;
  $('[data-sheet="-1"]', dialog).disabled = k <= 0;
  $('[data-sheet="1"]', dialog).disabled = k >= sheets.length - 1;
  $(".print-paper", dialog).textContent = sheet
    ? `Papel ${cm(sheet.width)} × ${cm(sheet.height)} cm, ${sheet.width > sheet.height ? "paisagem" : "retrato"}`
    : "";
  // No modo Tamanho, a escala da página (como no Acrobat).
  const item = values.layout.mode === "size" && sheet?.items.length === 1 ? sheet.items[0] : null;
  $(".print-scale", dialog).textContent = item ? `Escala: ${Math.round(item.scale * 100)}%` : "";
  const hint = $(".print-booklet-hint", dialog);
  if (booklet) {
    const total = Math.ceil(values.indices.length / 4);
    form.elements.sheetTo.placeholder = String(total);
    form.elements.sheetFrom.max = form.elements.sheetTo.max = String(total);
    const paper = `${plan.physical} ${plan.physical === 1 ? "folha" : "folhas"} de papel, 4 páginas em cada uma.`;
    const duplex =
      values.layout.bookletSides !== "both"
        ? ""
        : PLATFORM === "desktop"
          ? " Na impressora sem frente e verso automático, imprima só a frente, vire o maço e imprima só o verso."
          : " Na janela de impressão, escolha frente e verso virando na borda curta (ou imprima só a frente, vire o maço e imprima só o verso).";
    hint.textContent = paper + duplex;
  }
}

function previewMessage(text) {
  const box = $(".print-preview-message", dialog);
  box.textContent = text || "";
  box.hidden = !text;
  $(".print-sheet", dialog).hidden = Boolean(text);
}

async function drawPreview() {
  const s = session;
  const sheet = s?.plan?.sheets[s.sheet];
  if (!sheet) return previewMessage(s?.plan ? "Nenhuma folha para imprimir." : null);
  const area = $(".print-sheet-area", dialog);
  const room = Math.min((area.clientWidth - 32) / sheet.width, (area.clientHeight - 32) / sheet.height);
  if (!(room > 0)) return;
  const token = ++s.token;
  area.classList.add("loading");
  try {
    const bytes = await sheetsPdf(s, s.plan, [s.sheet]);
    if (token !== s.token) return;
    const pdf = await pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes }).promise;
    try {
      const page = await pdf.getPage(1);
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: room * ratio });
      const canvas = el("canvas", { class: "print-sheet", width: Math.round(viewport.width), height: Math.round(viewport.height) });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;
      if (token !== s.token) return;
      canvas.style.width = `${Math.round(sheet.width * room)}px`;
      canvas.style.height = `${Math.round(sheet.height * room)}px`;
      canvas.classList.toggle("gray", form.elements.grayscale.checked);
      $(".print-sheet", area).replaceWith(canvas);
      previewMessage(null);
    } finally {
      pdf.destroy();
    }
  } catch (err) {
    console.error(err);
    if (token === s.token) previewMessage("Não foi possível mostrar esta folha.");
  } finally {
    if (token === s.token) area.classList.remove("loading");
  }
}

// ---- Imprimir e salvar ----

/** PDF com todas as folhas, conforme as opções escolhidas. */
async function buildSheets(s) {
  const info = await s.info;
  const plan = planSheets(s.values.indices.map((i) => info[i]), s.values.layout);
  if (!plan.sheets.length) throw new UserError("Nenhuma folha para imprimir com essas opções.");
  return { plan, bytes: await sheetsPdf(s, plan) };
}

async function saveSheets(s) {
  const { bytes } = await buildSheets(s);
  const saved = await platform.saveFile(bytes, { suggestedName: `${baseName(s.tab.name)} (impressão).pdf`, saveAs: true });
  if (saved) toast(`PDF das folhas salvo: ${saved.name}`);
}

async function printSheets(s) {
  const { plan, bytes } = await buildSheets(s);
  const first = plan.sheets[0];
  const landscape = first.width > first.height;
  if (PLATFORM === "desktop") return printOnDesktop(s, plan, bytes, landscape);
  if (PLATFORM === "android") return platform.printPdf(bytes, s.tab.name, { paper: s.values.layout.paper, landscape });
  return printInBrowser(plan, bytes, s.values.grayscale);
}

const FAILURES = {
  "Invalid deviceName provided": "a impressora não foi encontrada",
  "No printers available on the network": "nenhuma impressora disponível",
  failed: "a impressora não aceitou o trabalho",
};

async function printOnDesktop(s, plan, bytes, landscape) {
  const { values } = s;
  const paper = PAPERS[values.layout.paper];
  const microns = (pt) => Math.round((pt / 72) * 25400);
  const result = await platform.printDirect({
    data: bytes,
    name: s.tab.name,
    deviceName: values.printer || null,
    copies: values.copies,
    collate: values.collate,
    duplexMode: values.duplex,
    color: !values.grayscale,
    landscape,
    pageSize: paper.named || { width: microns(paper.width), height: microns(paper.height) },
  });
  if (!result?.ok) {
    if (result?.reason === "cancelled") return;
    const reason = FAILURES[result?.reason] || result?.reason;
    throw new UserError(`A impressão não foi enviada${reason ? `: ${reason}` : ""}.`);
  }
  const printer = values.printer ? form.elements.printer.selectedOptions[0]?.textContent || values.printer : "a impressora padrão";
  const pages = plan.sheets.length * values.copies;
  toast(`Enviado para ${printer}: ${pages} ${pages === 1 ? "página" : "páginas"}.`);
}

// ---- Navegador: as folhas viram imagens na página e o navegador imprime ----

function clearBrowserPrint() {
  if (!browserPrint) return;
  browserPrint.urls.forEach((url) => URL.revokeObjectURL(url));
  browserPrint.style.remove();
  $("#print-container").replaceChildren();
  browserPrint = null;
}

/** Resolução das imagens: mais nítida com poucas folhas, mais leve com muitas (e no celular). */
function rasterDpi(count) {
  const dpi = count <= 8 ? 300 : count <= 40 ? 200 : 150;
  return matchMedia("(pointer: coarse)").matches ? Math.min(dpi, 200) : dpi;
}

function toGrayscale(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  ctx.putImageData(image, 0, 0);
}

async function printInBrowser(plan, bytes, grayscale) {
  clearBrowserPrint();
  const container = $("#print-container");
  const [width, height] = [plan.sheets[0].width, plan.sheets[0].height];
  const dpi = rasterDpi(plan.sheets.length);
  const urls = [];
  const pdf = await pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes }).promise;
  try {
    for (let k = 0; k < plan.sheets.length; k++) {
      setBusy(`Preparando impressão… ${k + 1}/${plan.sheets.length}`);
      const page = await pdf.getPage(k + 1);
      // A folha na outra orientação gira para caber no papel da impressão.
      const sheet = plan.sheets[k];
      const turn = sheet.width > sheet.height !== width > height;
      const viewport = page.getViewport({ scale: dpi / 72, rotation: turn ? 90 : 0 });
      const canvas = el("canvas", { width: Math.round(viewport.width), height: Math.round(viewport.height) });
      const ctx = canvas.getContext("2d", { willReadFrequently: grayscale });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;
      if (grayscale) toGrayscale(ctx, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = el("img", { src: url, alt: "" });
      await img.decode();
      container.append(el("div", { class: "print-page" }, img));
    }
  } catch (err) {
    urls.forEach((url) => URL.revokeObjectURL(url));
    container.replaceChildren();
    throw err;
  } finally {
    pdf.destroy();
  }
  // A página impressa tem o tamanho do papel escolhido, sem margem.
  const style = el("style", { text: `@page { size: ${width}pt ${height}pt; margin: 0; }` });
  document.head.append(style);
  container.style.setProperty("--sheet-width", `${width}pt`);
  container.style.setProperty("--sheet-height", `${height}pt`);
  browserPrint = { urls, style };
  setBusy(false);
  // No celular a janela de impressão continua aberta depois que print() volta:
  // as imagens só saem quando ela fecha (ou na próxima impressão).
  window.addEventListener("afterprint", clearBrowserPrint, { once: true });
  window.print();
}
