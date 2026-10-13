import "pdfjs-dist/web/pdf_viewer.css";
import "./styles.css";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { renderIcons } from "./icons.js";
import * as pdfops from "./pdfops.js";
import { openSignatureDialog } from "./signature.js";
import * as platform from "./platform.js";

const { AnnotationEditorType, AnnotationEditorParamsType } = pdfjsLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
// O componente de visualização do PDF.js lê a biblioteca de globalThis.
globalThis.pdfjsLib = pdfjsLib;
const { EventBus, PDFLinkService, PDFFindController, PDFViewer, LinkTarget } = await import(
  "pdfjs-dist/web/pdf_viewer.mjs"
);

const LOAD_OPTIONS = {
  cMapUrl: "./pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "./pdfjs/standard_fonts/",
  isEvalSupported: false,
};

const TOOL_MODES = {
  select: AnnotationEditorType.NONE,
  highlight: AnnotationEditorType.HIGHLIGHT,
  text: AnnotationEditorType.FREETEXT,
  ink: AnnotationEditorType.INK,
  image: AnnotationEditorType.STAMP,
};

// Largura padrão da assinatura, em pontos do PDF (1/72 pol.).
const SIGNATURE_WIDTH_PT = 160;
const THUMB_WIDTH = 140;

const $ = (sel) => document.querySelector(sel);
const container = $("#viewer-container");

const state = {
  doc: null,
  name: "",
  path: null,
  dirty: false,
  tool: "select",
  signature: null,
  pendingPage: null,
  pendingScale: null,
};

// ---------------------------------------------------------------------------
// Visualizador (PDF.js)
// ---------------------------------------------------------------------------

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const findController = new PDFFindController({ eventBus, linkService });
const pdfViewer = new PDFViewer({
  container,
  viewer: $("#viewer"),
  eventBus,
  linkService,
  findController,
  annotationEditorMode: AnnotationEditorType.NONE,
  annotationEditorHighlightColors: "yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F",
  imageResourcesPath: "./pdfjs/images/",
});
linkService.setViewer(pdfViewer);

eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = state.pendingScale || "auto";
  if (state.pendingPage) {
    pdfViewer.currentPageNumber = Math.min(state.pendingPage, pdfViewer.pagesCount);
  }
  state.pendingPage = null;
  state.pendingScale = null;
  applyTool("select");
});

eventBus.on("pagechanging", ({ pageNumber }) => {
  $("#page-input").value = pageNumber;
  highlightThumbnail(pageNumber);
});

eventBus.on("scalechanging", ({ scale, presetValue }) => {
  const select = $("#zoom-select");
  const value = presetValue || String(scale);
  const match = [...select.options].find((o) => o.value === value && !o.hidden);
  if (match) {
    select.value = value;
  } else {
    const custom = select.querySelector('option[value="custom"]');
    custom.textContent = `${Math.round(scale * 100)}%`;
    select.value = "custom";
  }
});

eventBus.on("updatefindmatchescount", ({ matchesCount }) => showFindCount(matchesCount));
eventBus.on("updatefindcontrolstate", ({ state: findState, matchesCount }) => {
  if (findState === 1 /* NOT_FOUND */) $("#find-count").textContent = "Nenhum resultado";
  else showFindCount(matchesCount);
});

function showFindCount({ current, total } = {}) {
  $("#find-count").textContent = total ? `${current} de ${total}` : "";
}

// ---------------------------------------------------------------------------
// Abrir / salvar
// ---------------------------------------------------------------------------

function askPassword(incorrect) {
  const dialog = $("#password-dialog");
  const input = $("#password-input");
  $("#password-message").textContent = incorrect
    ? "Senha incorreta. Tente novamente."
    : "Digite a senha para abrir este PDF.";
  input.value = "";
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok" ? input.value : null), { once: true });
  });
}

async function openBytes(bytes, { name, path = null, dirty = false, page = null } = {}) {
  setBusy("Abrindo documento…");
  try {
    // getDocument transfere o buffer para o worker; passamos uma cópia.
    const task = pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes.slice() });
    task.onPassword = async (updatePassword, reason) => {
      setBusy(false);
      const password = await askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
      if (password === null) task.destroy();
      else updatePassword(password);
    };
    const doc = await task.promise;

    const previous = state.doc;
    if (previous) state.pendingScale = pdfViewer.currentScaleValue;
    state.doc = doc;
    state.name = name || "documento.pdf";
    state.path = path;
    state.pendingPage = page;
    doc.annotationStorage.onSetModified = () => setDirty(true);

    pdfViewer.setDocument(doc);
    linkService.setDocument(doc, null);
    previous?.destroy();

    document.body.classList.add("has-doc");
    $("#page-count").textContent = `/ ${doc.numPages}`;
    $("#page-input").value = page || 1;
    $("#find-input").value = "";
    $("#find-count").textContent = "";
    setDirty(dirty);
    buildThumbnails();
  } catch (err) {
    if (err?.name !== "AbortException" && !/destroyed|Worker was terminated/i.test(err?.message)) {
      console.error(err);
      toast(`Não foi possível abrir o arquivo: ${err.message}`);
    }
  } finally {
    setBusy(false);
  }
}

function confirmDiscard() {
  return !state.dirty || window.confirm("Há alterações não salvas. Deseja descartá-las?");
}

async function openFile(file) {
  if (!file || !confirmDiscard()) return;
  if (pdfops.isImage(file.name)) {
    const bytes = await pdfops.combineFiles([file]);
    await openBytes(bytes, { name: file.name.replace(/\.\w+$/, ".pdf"), dirty: true });
  } else {
    await openBytes(file.data, { name: file.name, path: file.path });
  }
}

async function openDialog() {
  const [file] = await platform.pickFiles({ pdfOnly: true });
  if (file) await openFile(file);
}

async function createFromFiles({ images }) {
  if (!confirmDiscard()) return;
  const files = await platform.pickFiles({ multiple: true, images });
  if (!files.length) return;
  setBusy("Criando PDF…");
  try {
    const bytes = await pdfops.combineFiles(files);
    await openBytes(bytes, { name: images ? "Imagens.pdf" : "Combinado.pdf", dirty: true });
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

/** Bytes do documento atual, incluindo anotações e campos de formulário editados. */
async function currentBytes() {
  // Tira o foco de uma caixa de texto em edição para que ela seja confirmada.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await new Promise((r) => setTimeout(r, 0));
  const doc = state.doc;
  return doc.annotationStorage.size > 0 ? doc.saveDocument() : doc.getData();
}

async function save({ saveAs = false } = {}) {
  if (!state.doc) return false;
  setBusy("Salvando…");
  try {
    const bytes = await currentBytes();
    const result = await platform.saveFile(bytes, {
      path: state.path,
      suggestedName: state.name,
      saveAs: saveAs || !state.path,
    });
    if (!result) return false;
    state.name = result.name;
    state.path = result.path;
    setDirty(false);
    toast(platform.isDesktop ? "Documento salvo." : "Download iniciado.");
    return true;
  } catch (err) {
    console.error(err);
    toast(`Erro ao salvar: ${err.message}`);
    return false;
  } finally {
    setBusy(false);
  }
}

function setDirty(dirty) {
  state.dirty = dirty;
  const title = state.doc ? `${state.dirty ? "• " : ""}${state.name} — PDF Acrobat` : "PDF Acrobat";
  document.title = title;
  platform.setWindowState({ dirty: state.dirty, title });
}

// ---------------------------------------------------------------------------
// Organizar páginas
// ---------------------------------------------------------------------------

const currentIndex = () => pdfViewer.currentPageNumber - 1;

/** Aplica uma operação estrutural (pdf-lib) e recarrega o documento. */
async function restructure(label, operation, { page } = {}) {
  if (!state.doc) return;
  setBusy(label);
  try {
    const bytes = await currentBytes();
    const { bytes: out } = await operation(bytes);
    await openBytes(out, { name: state.name, path: state.path, dirty: true, page: page ?? pdfViewer.currentPageNumber });
  } catch (err) {
    console.error(err);
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

const rotate = (delta) => restructure("Girando página…", (b) => pdfops.rotatePages(b, [currentIndex()], delta));

function deleteCurrentPage() {
  if (state.doc.numPages <= 1) return toast("Um PDF precisa ter pelo menos uma página.");
  const n = pdfViewer.currentPageNumber;
  if (!window.confirm(`Excluir a página ${n}?`)) return;
  restructure("Excluindo página…", (b) => pdfops.deletePages(b, [n - 1]), {
    page: Math.min(n, state.doc.numPages - 1),
  });
}

function movePage(from, to) {
  if (from === to) return;
  restructure("Movendo página…", (b) => pdfops.movePage(b, from, to), { page: to + 1 });
}

function insertBlank() {
  const at = currentIndex() + 1;
  restructure("Inserindo página…", (b) => pdfops.insertBlankPage(b, at), { page: at + 1 });
}

async function insertFiles() {
  const files = await platform.pickFiles({ multiple: true });
  if (!files.length) return;
  const at = currentIndex() + 1;
  restructure("Inserindo arquivos…", (b) => pdfops.insertFiles(b, files, at), { page: at + 1 });
}

/** "1-3, 5" -> [0, 1, 2, 4] */
function parseRange(text, total) {
  const out = new Set();
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) throw new Error(`Intervalo inválido: "${part}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > total || a > b) throw new Error(`Intervalo fora do documento: "${part}"`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  if (!out.size) throw new Error("Informe ao menos uma página.");
  return [...out].sort((x, y) => x - y);
}

async function extract() {
  const dialog = $("#extract-dialog");
  const input = $("#extract-range");
  input.value = String(pdfViewer.currentPageNumber);
  $("#extract-help").textContent = `O documento tem ${state.doc.numPages} página(s).`;
  dialog.showModal();
  input.select();
  const ok = await new Promise((r) => dialog.addEventListener("close", () => r(dialog.returnValue === "ok"), { once: true }));
  if (!ok) return;
  setBusy("Extraindo páginas…");
  try {
    const indices = parseRange(input.value, state.doc.numPages);
    const out = await pdfops.extractPages(await currentBytes(), indices);
    const base = state.name.replace(/\.pdf$/i, "");
    const saved = await platform.saveFile(out, { suggestedName: `${base} (páginas).pdf`, saveAs: true });
    if (saved) toast(`${indices.length} página(s) extraída(s).`);
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Ferramentas de edição
// ---------------------------------------------------------------------------

function setEditorParam(type, value) {
  eventBus.dispatch("switchannotationeditorparams", { source: window, type, value });
}

function applyToolParams() {
  const color = $("#opt-color").value;
  setEditorParam(AnnotationEditorParamsType.INK_COLOR, color);
  setEditorParam(AnnotationEditorParamsType.FREETEXT_COLOR, color);
  setEditorParam(AnnotationEditorParamsType.INK_THICKNESS, Number($("#opt-thickness").value));
  setEditorParam(AnnotationEditorParamsType.FREETEXT_SIZE, Number($("#opt-font-size").value));
  setEditorParam(AnnotationEditorParamsType.HIGHLIGHT_DEFAULT_COLOR, $("#opt-highlight").value);
}

function applyTool(tool) {
  state.tool = tool;
  if (tool !== "sign") stopSignaturePlacement();
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool);
    b.setAttribute("aria-checked", String(b.dataset.tool === tool));
  });
  document.querySelectorAll("#tool-options .opt").forEach((el) => {
    el.hidden = !el.dataset.for.split(" ").includes(tool);
  });
  if (!state.doc) return;
  try {
    pdfViewer.annotationEditorMode = { mode: TOOL_MODES[tool] ?? AnnotationEditorType.NONE };
  } catch (err) {
    console.warn(err);
  }
  applyToolParams();
}

async function selectTool(tool) {
  if (!state.doc) return;
  if (tool === "sign") return startSignature();
  applyTool(tool);
  // A ferramenta Imagem abre direto a escolha do arquivo.
  if (tool === "image") setEditorParam(AnnotationEditorParamsType.CREATE, null);
}

async function startSignature() {
  applyTool("select");
  const signature = await openSignatureDialog();
  if (!signature) return;
  state.signature = signature;
  applyTool("sign");
  const ghost = $("#sign-ghost");
  ghost.querySelector("img").src = signature.previewUrl;
  container.classList.add("placing-signature");
}

function stopSignaturePlacement() {
  if (state.signature?.previewUrl) URL.revokeObjectURL(state.signature.previewUrl);
  state.signature = null;
  container.classList.remove("placing-signature");
  $("#sign-ghost").hidden = true;
}

function signatureSizePx() {
  const w = SIGNATURE_WIDTH_PT * pdfViewer.currentScale * pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS;
  return [w, w / state.signature.aspect];
}

container.addEventListener("pointermove", (e) => {
  if (!state.signature) return;
  const ghost = $("#sign-ghost");
  const onPage = e.target.closest?.(".page");
  ghost.hidden = !onPage;
  const [w, h] = signatureSizePx();
  Object.assign(ghost.style, {
    width: `${w}px`,
    height: `${h}px`,
    left: `${e.clientX - w / 2}px`,
    top: `${e.clientY - h / 2}px`,
  });
});
container.addEventListener("pointerleave", () => ($("#sign-ghost").hidden = true));

container.addEventListener(
  "click",
  (e) => {
    if (!state.signature) return;
    const pageDiv = e.target.closest?.(".page");
    if (!pageDiv) return;
    e.preventDefault();
    e.stopPropagation();
    const pageNumber = Number(pageDiv.dataset.pageNumber);
    const pageView = pdfViewer.getPageView(pageNumber - 1);
    const rect = (pageDiv.querySelector(".canvasWrapper") || pageDiv).getBoundingClientRect();
    const [w, h] = signatureSizePx();
    // Canto inferior esquerdo da assinatura, como visto na tela.
    const x = e.clientX - rect.left - w / 2;
    const y = e.clientY - rect.top + h / 2;
    const origin = pageView.viewport.convertToPdfPoint(x, y);
    const scale = pageView.viewport.scale;
    const signature = state.signature;
    applyTool("select");
    restructure(
      "Aplicando assinatura…",
      (b) =>
        pdfops.stampImage(b, {
          pageIndex: pageNumber - 1,
          pngBytes: signature.png,
          origin,
          width: w / scale,
          height: h / scale,
          rotation: pageView.pdfPage.rotate,
        }),
      { page: pageNumber },
    );
  },
  true,
);

// ---------------------------------------------------------------------------
// Miniaturas
// ---------------------------------------------------------------------------

let thumbObserver = null;
let dragFrom = null;

function buildThumbnails() {
  const list = $("#thumbnails");
  list.replaceChildren();
  thumbObserver?.disconnect();
  const doc = state.doc;
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          thumbObserver.unobserve(entry.target);
          renderThumbnail(doc, entry.target);
        }
      }
    },
    { root: $("#sidebar"), rootMargin: "300px" },
  );

  for (let n = 1; n <= doc.numPages; n++) {
    const item = document.createElement("button");
    item.className = "thumb";
    item.dataset.page = n;
    item.draggable = true;
    item.title = `Página ${n}`;
    item.innerHTML = `<div class="thumb-image"></div><span class="thumb-label">${n}</span>`;
    item.addEventListener("click", () => (pdfViewer.currentPageNumber = n));
    item.addEventListener("dragstart", (e) => {
      dragFrom = n - 1;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(n));
    });
    item.addEventListener("dragover", (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      const after = e.offsetY > item.offsetHeight / 2;
      item.classList.toggle("drop-before", !after);
      item.classList.toggle("drop-after", after);
    });
    item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
    item.addEventListener("drop", (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.stopPropagation();
      const after = item.classList.contains("drop-after");
      item.classList.remove("drop-before", "drop-after");
      let to = n - 1 + (after ? 1 : 0);
      if (to > dragFrom) to -= 1;
      const from = dragFrom;
      dragFrom = null;
      movePage(from, to);
    });
    item.addEventListener("dragend", () => (dragFrom = null));
    list.append(item);
    thumbObserver.observe(item);
  }
  highlightThumbnail(pdfViewer.currentPageNumber || 1);
}

async function renderThumbnail(doc, item) {
  try {
    const page = await doc.getPage(Number(item.dataset.page));
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    if (doc === state.doc) item.querySelector(".thumb-image").replaceChildren(canvas);
  } catch {
    // Documento substituído durante a renderização.
  }
}

function highlightThumbnail(n) {
  const list = $("#thumbnails");
  list.querySelector(".thumb.active")?.classList.remove("active");
  const item = list.querySelector(`.thumb[data-page="${n}"]`);
  if (item) {
    item.classList.add("active");
    if (!$("#sidebar").hidden) item.scrollIntoView({ block: "nearest" });
  }
}

function toggleSidebar() {
  const sidebar = $("#sidebar");
  sidebar.hidden = !sidebar.hidden;
  $("#btn-sidebar").classList.toggle("active", !sidebar.hidden);
  if (!sidebar.hidden) highlightThumbnail(pdfViewer.currentPageNumber);
}

// ---------------------------------------------------------------------------
// Impressão
// ---------------------------------------------------------------------------

async function print() {
  if (!state.doc) return;
  setBusy("Preparando impressão…");
  const printContainer = $("#print-container");
  let doc = null;
  try {
    const bytes = await currentBytes();
    doc = await pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes.slice() }).promise;
    const urls = [];
    for (let n = 1; n <= doc.numPages; n++) {
      setBusy(`Preparando impressão… ${n}/${doc.numPages}`);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 150 / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const wrap = document.createElement("div");
      wrap.className = "print-page";
      const img = new Image();
      img.src = url;
      wrap.append(img);
      printContainer.append(wrap);
      await img.decode();
    }
    setBusy(false);
    window.print();
    urls.forEach((u) => URL.revokeObjectURL(u));
  } catch (err) {
    console.error(err);
    toast(`Erro ao imprimir: ${err.message}`);
  } finally {
    printContainer.replaceChildren();
    doc?.destroy();
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Propriedades
// ---------------------------------------------------------------------------

const PAPER_SIZES = { A4: [210, 297], A3: [297, 420], A5: [148, 210], Carta: [216, 279], Ofício: [216, 356] };

function paperName(wMm, hMm) {
  const [a, b] = [Math.min(wMm, hMm), Math.max(wMm, hMm)];
  for (const [name, [w, h]] of Object.entries(PAPER_SIZES)) {
    if (Math.abs(a - w) < 3 && Math.abs(b - h) < 3) return name;
  }
  return null;
}

function formatDate(value) {
  const date = value && pdfjsLib.PDFDateString.toDateObject(value);
  return date ? date.toLocaleString("pt-BR") : "";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

async function showProperties() {
  if (!state.doc) return;
  const doc = state.doc;
  const [{ info }, data, page] = await Promise.all([doc.getMetadata(), doc.getData(), doc.getPage(1)]);
  const [x0, y0, x1, y1] = page.view;
  const wMm = ((x1 - x0) / 72) * 25.4;
  const hMm = ((y1 - y0) / 72) * 25.4;
  const paper = paperName(wMm, hMm);
  const rows = [
    ["Arquivo", state.name],
    ["Local", state.path],
    ["Título", info.Title],
    ["Autor", info.Author],
    ["Assunto", info.Subject],
    ["Aplicativo", info.Creator],
    ["Produtor do PDF", info.Producer],
    ["Criado em", formatDate(info.CreationDate)],
    ["Modificado em", formatDate(info.ModDate)],
    ["Versão do PDF", info.PDFFormatVersion],
    ["Páginas", doc.numPages],
    ["Tamanho da página", `${wMm.toFixed(0)} × ${hMm.toFixed(0)} mm${paper ? ` (${paper})` : ""}`],
    ["Tamanho do arquivo", formatSize(data.length)],
    ["Formulário", info.IsAcroFormPresent || info.IsXFAPresent ? "Sim" : "Não"],
  ];
  const list = $("#properties-list");
  list.replaceChildren();
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === "") continue;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    list.append(dt, dd);
  }
  $("#properties-dialog").showModal();
}

// ---------------------------------------------------------------------------
// Interface geral
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function setBusy(message) {
  $("#busy").hidden = !message;
  if (message) $("#busy-text").textContent = message;
}

function find(previous = false) {
  const query = $("#find-input").value;
  if (!query) return showFindCount();
  eventBus.dispatch("find", {
    source: window,
    type: "again",
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
    matchDiacritics: false,
  });
}

function zoom(direction) {
  if (!state.doc) return;
  if (direction > 0) pdfViewer.increaseScale();
  else pdfViewer.decreaseScale();
}

const actions = {
  open: openDialog,
  save: () => save(),
  "save-as": () => save({ saveAs: true }),
  "save-and-close": async () => {
    if (await save()) platform.closeWindow();
  },
  print,
  properties: showProperties,
  find: () => {
    if (!state.doc) return;
    $("#find-input").focus();
    $("#find-input").select();
  },
  "zoom-in": () => zoom(1),
  "zoom-out": () => zoom(-1),
  "fit-width": () => state.doc && (pdfViewer.currentScaleValue = "page-width"),
  "fit-page": () => state.doc && (pdfViewer.currentScaleValue = "page-fit"),
  "toggle-sidebar": () => state.doc && toggleSidebar(),
  combine: () => createFromFiles({ images: false }),
  "create-from-images": () => createFromFiles({ images: true }),
};

function bind(id, fn) {
  $(id).addEventListener("click", fn);
}

function setupUi() {
  renderIcons();

  bind("#btn-open", actions.open);
  bind("#btn-save", actions.save);
  bind("#btn-print", actions.print);
  bind("#btn-sidebar", actions["toggle-sidebar"]);
  bind("#btn-properties", actions.properties);
  bind("#btn-prev", () => pdfViewer.previousPage());
  bind("#btn-next", () => pdfViewer.nextPage());
  bind("#btn-zoom-in", actions["zoom-in"]);
  bind("#btn-zoom-out", actions["zoom-out"]);
  bind("#btn-rotate-cw", () => rotate(90));
  bind("#btn-rotate-ccw", () => rotate(-90));
  bind("#btn-delete-page", deleteCurrentPage);
  bind("#btn-blank-page", insertBlank);
  bind("#btn-insert", insertFiles);
  bind("#btn-extract", extract);
  bind("#btn-find-next", () => find(false));
  bind("#btn-find-prev", () => find(true));
  bind("#welcome-open", actions.open);
  bind("#welcome-images", actions["create-from-images"]);
  bind("#welcome-combine", actions.combine);

  $("#page-input").addEventListener("change", (e) => {
    const n = parseInt(e.target.value, 10);
    if (state.doc && n >= 1 && n <= state.doc.numPages) pdfViewer.currentPageNumber = n;
    else e.target.value = pdfViewer.currentPageNumber;
  });

  $("#zoom-select").addEventListener("change", (e) => {
    if (state.doc && e.target.value !== "custom") pdfViewer.currentScaleValue = e.target.value;
  });

  const findInput = $("#find-input");
  findInput.addEventListener("input", () => {
    if (!findInput.value) {
      eventBus.dispatch("find", { source: window, type: "", query: "", highlightAll: false });
      showFindCount();
      return;
    }
    eventBus.dispatch("find", {
      source: window,
      type: "",
      query: findInput.value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: false,
    });
  });
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      find(e.shiftKey);
    }
  });

  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => selectTool(b.dataset.tool)));
  ["#opt-color", "#opt-thickness", "#opt-font-size", "#opt-highlight"].forEach((id) =>
    $(id).addEventListener("input", applyToolParams),
  );
  applyTool("select");

  container.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !state.doc) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  document.addEventListener("keydown", onKeyDown);
  setupDragAndDrop();

  platform.onMenu((action) => actions[action]?.());
  platform.onOpenFile(openFile);
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty && !platform.isDesktop) e.preventDefault();
  });
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function onKeyDown(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (document.querySelector("dialog[open]")) return;
  if (mod) {
    const key = e.key.toLowerCase();
    const map = {
      o: "open",
      s: e.shiftKey ? "save-as" : "save",
      p: "print",
      f: "find",
      d: "properties",
      "=": "zoom-in",
      "+": "zoom-in",
      "-": "zoom-out",
    };
    if (map[key]) {
      e.preventDefault();
      actions[map[key]]();
    }
    return;
  }
  if (e.key === "Escape" && state.tool !== "select") {
    applyTool("select");
    return;
  }
  if (!state.doc || isTyping(e.target)) return;
  const tools = { v: "select", h: "highlight", t: "text", d: "ink" };
  if (tools[e.key.toLowerCase()] && !e.altKey) {
    selectTool(tools[e.key.toLowerCase()]);
  }
}

function setupDragAndDrop() {
  const overlay = $("#drop-overlay");
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...e.dataTransfer.files].filter((f) => /\.(pdf|png|jpe?g)$/i.test(f.name));
    if (!files.length) return toast("Solte um arquivo PDF ou uma imagem.");
    const loaded = await Promise.all(files.map(platform.fileFromBrowser));
    if (loaded.length === 1) return openFile(loaded[0]);
    if (!confirmDiscard()) return;
    const bytes = await pdfops.combineFiles(loaded);
    await openBytes(bytes, { name: "Combinado.pdf", dirty: true });
  });
}

setupUi();
setDirty(false);
const initial = await platform.getInitialFile();
if (initial) openFile(initial);

// Usado pelos testes automatizados.
window.__app = { state, pdfViewer, openBytes, currentBytes };
