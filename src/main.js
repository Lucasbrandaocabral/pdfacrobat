import "pdfjs-dist/web/pdf_viewer.css";
import "./styles.css";
import { renderIcons } from "./icons.js";
import { $, $$, askText, baseName, debounce, el, notice, openDialog, runBusy, setBusy, toast } from "./ui.js";
import { TabManager } from "./tabs.js";
import { Sidebar } from "./sidebar.js";
import { ToolController } from "./tools.js";
import * as platform from "./platform.js";
import * as ops from "./pdf/ops.js";
import * as documentFeatures from "./features/document.js";
import * as convert from "./features/convert.js";
import { ocr } from "./features/ocr.js";
import { compare } from "./features/compare.js";
import { certSign } from "./features/certsign.js";
import * as fillSign from "./features/fillsign.js";
import * as printing from "./features/print.js";
import * as splitting from "./features/split.js";
import { removePages } from "./features/pagetools.js";
import { crop } from "./features/crop.js";
import { redact } from "./features/redact.js";
import { repair, repairAndOpen } from "./features/repair.js";
import { setupUpdates } from "./updates.js";
import { setupAndroid } from "./android.js";

const PDFJS_EDITOR_TOOLS = new Set(["highlight", "text", "ink", "image"]);
const manager = new TabManager($("#viewer-area"), $("#tabbar"));

const app = {
  manager,
  tools: null,
  sidebar: null,
  run: runBusy,
  guard: (tab, flag, what) => tab.requestPermission(flag, what),
  openDocument,
  updateTitle,
};
app.tools = new ToolController(manager, app);
app.sidebar = new Sidebar(manager, {
  // Antes de mexer no documento pela barra lateral, conclui a edição aberta.
  movePage: async (tab, from, to) => {
    await app.tools.settled();
    return documentFeatures.movePage(app, tab, from, to);
  },
  deletePage: async (tab, index) => {
    await app.tools.settled();
    return documentFeatures.deletePageAt(app, tab, index);
  },
  rotatePage: async (tab, index, delta) => {
    await app.tools.settled();
    return documentFeatures.rotatePageAt(app, tab, index, delta);
  },
  guard: app.guard,
  run: async (message, task) => {
    await app.tools.settled();
    return app.run(message, task);
  },
});

// ---------------------------------------------------------------------------
// Abrir, salvar e fechar
// ---------------------------------------------------------------------------

async function openDocument(bytes, { name, path = null, dirty = false } = {}) {
  setBusy("Abrindo documento…");
  try {
    const tab = await manager.open(bytes, { name, path, dirty });
    if (path) addRecent({ name, path });
    return tab;
  } catch (err) {
    if (/AbortException|destroyed|terminated/i.test(`${err?.name} ${err?.message}`)) return null;
    console.error(err);
    // Arquivo danificado: oferece reparar (a senha recusada não é dano).
    if (bytes?.length && !/Password/i.test(err?.name)) {
      setBusy(false);
      return repairAndOpen(app, bytes, name);
    }
    toast(`Não foi possível abrir "${name}": ${err.message}`, { duration: 6000 });
    return null;
  } finally {
    setBusy(false);
  }
}

async function openFiles(files) {
  const images = files.filter((f) => ops.isImage(f.name));
  for (const file of files.filter((f) => !ops.isImage(f.name))) {
    await openDocument(file.data, { name: file.name, path: file.path });
  }
  if (images.length) {
    const bytes = await runBusy("Criando PDF…", () => ops.combineFiles(images));
    if (bytes) {
      const name = images.length === 1 ? `${baseName(images[0].name)}.pdf` : "Imagens.pdf";
      await openDocument(bytes, { name, dirty: true });
    }
  }
}

async function chooseAndOpen() {
  const files = await platform.pickFiles({ multiple: true, kind: "pdf" });
  if (files.length) await openFiles(files);
}

async function createFromFiles(kind) {
  const files = await platform.pickFiles({ multiple: true, kind });
  if (!files.length) return;
  const bytes = await runBusy("Criando PDF…", () => ops.combineFiles(files));
  if (bytes) await openDocument(bytes, { name: kind === "images" ? "Imagens.pdf" : "Combinado.pdf", dirty: true });
}

async function saveTab(tab, { saveAs = false } = {}) {
  if (!tab) return false;
  // A edição aberta (ex.: assinatura ainda na caixa) entra no arquivo salvo.
  await app.tools.settled();
  const ok = await runBusy("Salvando…", async () => {
    const bytes = await tab.currentBytes();
    const result = await platform.saveFile(bytes, { path: tab.path, suggestedName: tab.name, saveAs: saveAs || !tab.path });
    if (!result) return false;
    tab.name = result.name;
    tab.path = result.path;
    tab.size = bytes.length;
    tab.setDirty(false);
    manager.render();
    updateTitle();
    if (result.path) addRecent(result);
    toast(platform.isDesktop || platform.isAndroid ? "Documento salvo." : "Download iniciado.");
    return true;
  });
  return ok === true;
}

/** Abre um diálogo de escolha (Salvar / Não salvar / Cancelar) e resolve com o valor do botão. */
function askChoice(dialog) {
  dialog.returnValue = "";
  dialog.showModal();
  $('button[value="ok"]', dialog).focus();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true }));
}

function askUnsaved(name) {
  const dialog = $("#unsaved-dialog");
  $("h2", dialog).textContent = `Salvar as alterações em “${name}”?`;
  return askChoice(dialog);
}

/**
 * Fechar a janela com documentos alterados (o app de computador pergunta pela
 * interface, não pela janela do sistema): Salvar (todos), Não salvar ou Cancelar.
 */
async function confirmClose() {
  const dialog = $("#close-dialog");
  if (dialog.open) return;
  const dirty = manager.tabs.filter((t) => t.dirty);
  if (!dirty.length) return platform.closeWindow();
  $(".message", dialog).textContent = dirty.length === 1 ? "Este documento tem alterações que ainda não foram salvas:" : `Estes ${dirty.length} documentos têm alterações que ainda não foram salvas:`;
  $(".close-list", dialog).replaceChildren(...dirty.map((t) => el("li", { text: t.name, title: t.path || t.name })));
  $('button[value="ok"]', dialog).textContent = dirty.length === 1 ? "Salvar" : "Salvar todos";
  const choice = await askChoice(dialog);
  if (choice === "ok") await saveAllAndClose();
  else if (choice === "discard") platform.closeWindow();
}

/** Janela "Sobre" com a marca e a versão. */
function showAbout() {
  const dialog = $("#about-dialog");
  $("[data-version]", dialog).textContent = `Versão ${platform.APP_VERSION}`;
  return openDialog(dialog, { focus: ".about-ok" });
}

async function closeTab(tab) {
  if (!tab) return false;
  if (app.tools.editing?.hit?.tab === tab) await app.tools.settled();
  if (tab.dirty) {
    manager.activate(tab);
    const choice = await askUnsaved(tab.name);
    if (choice === "cancel") return false;
    if (choice === "ok" && !(await saveTab(tab))) return false;
  }
  manager.remove(tab);
  return true;
}

/** Antes de reiniciar para atualizar: salva ou descarta os documentos alterados. */
async function closeUnsaved() {
  for (const tab of manager.tabs.filter((t) => t.dirty)) {
    if (!(await closeTab(tab))) return false;
  }
  return true;
}

async function saveAllAndClose() {
  for (const tab of manager.tabs.filter((t) => t.dirty)) {
    manager.activate(tab);
    if (!(await saveTab(tab))) return;
  }
  platform.closeWindow();
}

// ---------------------------------------------------------------------------
// Estado da janela e da barra superior
// ---------------------------------------------------------------------------

function updateTitle() {
  const tab = manager.active;
  const title = tab ? `${tab.dirty ? "• " : ""}${tab.name} — PDF Acrobat` : "PDF Acrobat";
  document.title = title;
  document.body.classList.toggle("has-doc", Boolean(tab));
  platform.setWindowState({ dirty: manager.tabs.some((t) => t.dirty), title });
  if (!tab) renderRecent();
}

function syncPageUi(tab) {
  if (!tab?.doc) return;
  $("#page-count").textContent = `/ ${tab.doc.numPages}`;
  $("#page-input").value = tab.viewer.currentPageNumber || 1;
  updateZoomSelect({ scale: tab.viewer.currentScale, presetValue: tab.viewer.currentScaleValue });
  showFindCount();
}

function updateZoomSelect({ scale, presetValue }) {
  const select = $("#zoom-select");
  const value = String(presetValue ?? scale);
  const match = [...select.options].find((o) => o.value === value && !o.hidden);
  if (match) select.value = value;
  else {
    const custom = select.querySelector('option[value="custom"]');
    custom.textContent = `${Math.round(scale * 100)}%`;
    select.value = "custom";
  }
}

function showFindCount({ current, total } = {}) {
  $("#find-count").textContent = total ? `${current} de ${total}` : "";
}

manager.on("dirty", () => {
  manager.render();
  updateTitle();
});
manager.on("activate", (tab) => {
  updateTitle();
  syncPageUi(tab);
  fillSign.updateFormsHint(tab);
});
manager.on("loaded", (tab) => {
  if (!tab.active) return;
  syncPageUi(tab);
  fillSign.updateFormsHint(tab);
});
manager.on("pagechange", (tab, n) => tab.active && ($("#page-input").value = n));
manager.on("scalechange", (tab, e) => tab.active && updateZoomSelect(e));
manager.on("findcount", (tab, count) => tab.active && showFindCount(count));
manager.on("findstate", (tab, { state, matchesCount }) => {
  if (!tab.active) return;
  if (state === 1) $("#find-count").textContent = "Nenhum resultado";
  else showFindCount(matchesCount);
});
manager.on("closerequest", (tab) => closeTab(tab));

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

function find(previous = false, type = "again") {
  const tab = manager.active;
  const query = $("#find-input").value;
  if (!tab) return;
  if (!query) {
    tab.eventBus.dispatch("find", { source: window, type: "", query: "", highlightAll: false });
    showFindCount();
    return;
  }
  tab.eventBus.dispatch("find", {
    source: window,
    type,
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
    matchDiacritics: false,
  });
}

function zoom(direction) {
  const tab = manager.active;
  if (!tab?.doc) return;
  if (direction > 0) tab.viewer.increaseScale();
  else tab.viewer.decreaseScale();
}

async function undoRedo(kind) {
  const tab = manager.active;
  if (!tab) return;
  // Desfazer com uma caixa aberta (assinatura, imagem ou texto) só a descarta.
  if (kind === "undo" && ["signature", "image", "text"].includes(app.tools.editing?.kind)) return app.tools.clearEdit();
  if (PDFJS_EDITOR_TOOLS.has(app.tools.tool)) {
    tab.eventBus.dispatch("editingaction", { source: window, name: kind });
    return;
  }
  const done = await runBusy(kind === "undo" ? "Desfazendo…" : "Refazendo…", () => (kind === "undo" ? tab.undo() : tab.redo()));
  if (done === false) toast(kind === "undo" ? "Nada para desfazer." : "Nada para refazer.");
}

async function setAuthorName() {
  const name = await askText({
    title: "Nome do autor",
    label: "Nome que aparece nos comentários, notas e carimbos:",
    value: await platform.getUserName(),
    ok: "Salvar",
  });
  if (name?.trim()) {
    platform.setUserName(name.trim());
    toast("Nome do autor atualizado.");
  }
}

const actions = {
  open: chooseAndOpen,
  save: () => saveTab(manager.active),
  "save-as": () => saveTab(manager.active, { saveAs: true }),
  "save-all-and-close": saveAllAndClose,
  "confirm-close": confirmClose,
  about: showAbout,
  "close-tab": () => closeTab(manager.active),
  "next-tab": () => manager.cycle(1),
  "prev-tab": () => manager.cycle(-1),
  print: () => printing.print(app),
  properties: () => documentFeatures.properties(app),
  undo: () => undoRedo("undo"),
  redo: () => undoRedo("redo"),
  find: () => {
    if (!manager.active) return;
    $("#find-input").focus();
    $("#find-input").select();
  },
  "find-next": () => find(false),
  "find-prev": () => find(true),
  "zoom-in": () => zoom(1),
  "zoom-out": () => zoom(-1),
  "fit-width": () => manager.active && (manager.active.viewer.currentScaleValue = "page-width"),
  "fit-page": () => manager.active && (manager.active.viewer.currentScaleValue = "page-fit"),
  "toggle-sidebar": () => manager.active && app.sidebar.toggle(),
  "prev-page": () => manager.active?.viewer.previousPage(),
  "next-page": () => manager.active?.viewer.nextPage(),
  "rotate-cw": () => documentFeatures.rotate(app, 90),
  "rotate-ccw": () => documentFeatures.rotate(app, -90),
  "delete-page": () => removePages(app),
  "blank-page": () => documentFeatures.insertBlank(app),
  "insert-files": () => documentFeatures.insertFiles(app),
  extract: () => splitting.extract(app),
  split: () => splitting.split(app),
  crop: () => crop(app),
  watermark: () => documentFeatures.watermark(app),
  "header-footer": () => documentFeatures.headerFooter(app),
  protect: () => documentFeatures.protect(app),
  unprotect: () => documentFeatures.unprotect(app),
  compress: () => documentFeatures.compress(app),
  "cert-sign": () => certSign(app),
  redact: () => redact(app),
  repair: () => repair(app),
  "export-images": () => convert.exportImages(app),
  "export-text": () => convert.exportText(app),
  "export-word": () => convert.exportWord(app),
  ocr: () => ocr(app),
  compare: () => compare(app),
  combine: () => createFromFiles("pdfAndImages"),
  "create-from-images": () => createFromFiles("images"),
  "author-name": setAuthorName,
  sign: () => fillSign.sign(app, "signature"),
  "sign-initials": () => fillSign.sign(app, "initials"),
  "check-updates": () => checkForUpdates(),
};

// Ações que não mexem no documento deixam aberta a edição em andamento (a
// assinatura na caixa, a imagem sendo movida). Antes das outras ela é
// concluída, como ao clicar fora dela.
const LEAVES_EDIT_OPEN = new Set([
  "undo",
  "find",
  "find-next",
  "find-prev",
  "zoom-in",
  "zoom-out",
  "fit-width",
  "fit-page",
  "toggle-sidebar",
  "prev-page",
  "next-page",
  "properties",
  "author-name",
  "check-updates",
  "about",
  "confirm-close",
]);

async function runAction(name) {
  try {
    if (!LEAVES_EDIT_OPEN.has(name)) await app.tools.settled();
    if (name.startsWith("tool:")) return await app.tools.select(name.slice(5));
    if (name.startsWith("shape:")) return app.tools.setShape(name.slice(6));
    if (name.startsWith("mark:")) return app.tools.setMark(name.slice(5));
    await actions[name]?.();
  } catch (err) {
    console.error(err);
    toast(err?.userMessage || err?.message || String(err), { duration: 6000, kind: "error" });
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

function setCategory(name) {
  $$("[data-category]").forEach((b) => b.classList.toggle("active", b.dataset.category === name));
  $$(".tools[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  try {
    localStorage.setItem("category", name);
  } catch {
    // Preferência só nesta sessão.
  }
}

function setupMenus() {
  const close = () => $$(".menu").forEach((m) => (m.hidden = true));
  $$("[data-menu]").forEach((button) =>
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = $(`#${button.dataset.menu}`);
      const wasOpen = !menu.hidden;
      close();
      if (wasOpen) return;
      if (menu.id === "sign-menu") fillSign.renderMenu();
      const rect = button.getBoundingClientRect();
      menu.hidden = false;
      menu.style.left = `${Math.max(8, Math.min(rect.left - 120, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${rect.bottom + 4}px`;
    }),
  );
  $$("#shape-menu [data-shape]").forEach((b) => b.addEventListener("click", () => (close(), app.tools.setShape(b.dataset.shape))));
  $("#stamp-menu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-stamp]");
    if (!item) return;
    close();
    app.tools.setStamp(item.dataset.stamp);
  });
  fillSign.setupMenu(app, close);
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
}

function setupToolbar() {
  renderIcons();
  $$("[data-action]").forEach((b) => b.addEventListener("click", () => runAction(b.dataset.action)));
  $$("[data-tool]").forEach((b) => b.addEventListener("click", () => app.tools.select(b.dataset.tool)));
  $$("[data-mark]").forEach((b) => b.addEventListener("click", () => app.tools.setMark(b.dataset.mark)));
  $$("[data-category]").forEach((b) => b.addEventListener("click", () => setCategory(b.dataset.category)));
  let category = "comment";
  try {
    category = localStorage.getItem("category") || category;
  } catch {
    // Sem armazenamento: usa o padrão.
  }
  setCategory(category);
  setupMenus();
  app.tools.apply("select");

  $("#page-input").addEventListener("change", (e) => {
    const tab = manager.active;
    const n = parseInt(e.target.value, 10);
    if (tab && n >= 1 && n <= tab.doc.numPages) tab.viewer.currentPageNumber = n;
    else if (tab) e.target.value = tab.viewer.currentPageNumber;
  });
  $("#zoom-select").addEventListener("change", (e) => {
    const tab = manager.active;
    if (tab && e.target.value !== "custom") tab.viewer.currentScaleValue = e.target.value;
  });
  const findInput = $("#find-input");
  findInput.addEventListener("input", () => find(false, ""));
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      find(e.shiftKey);
    }
  });
  $("#viewer-area").addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !manager.active) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  window.addEventListener("resize", debounce(() => manager.active?.refreshLayout(), 150));
}

// ---------------------------------------------------------------------------
// Teclado
// ---------------------------------------------------------------------------

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

const SHORTCUTS = {
  o: "open",
  s: "save",
  p: "print",
  f: "find",
  d: "properties",
  w: "close-tab",
  z: "undo",
  y: "redo",
  "=": "zoom-in",
  "+": "zoom-in",
  "-": "zoom-out",
};
const TOOL_KEYS = { v: "select", h: "highlight", u: "underline", k: "strike", n: "note", t: "text", d: "ink", e: "edit" };

function onKeyDown(e) {
  if (document.querySelector("dialog[open]")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === "Tab") {
    e.preventDefault();
    manager.cycle(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "F4") {
    e.preventDefault();
    runAction("toggle-sidebar");
    return;
  }
  if (mod) {
    const key = e.key.toLowerCase();
    let action = SHORTCUTS[key];
    if (key === "s" && e.shiftKey) action = "save-as";
    if (key === "z" && e.shiftKey) action = "redo";
    if ((action === "undo" || action === "redo") && isTyping(e.target)) return;
    if (action) {
      e.preventDefault();
      runAction(action);
    }
    return;
  }
  if (e.key === "Escape" && app.tools.tool !== "select" && !app.tools.editing) {
    app.tools.apply("select");
    return;
  }
  if (!manager.active || isTyping(e.target) || e.altKey) return;
  let tool = TOOL_KEYS[e.key.toLowerCase()];
  // T: texto na página em Editar e em Preencher e assinar; caixa de texto (comentário) em Comentar.
  if (tool === "text" && $("[data-category].active")?.dataset.category !== "comment") tool = "addtext";
  if (tool) app.tools.select(tool);
}

// ---------------------------------------------------------------------------
// Arrastar e soltar, recentes e inicialização
// ---------------------------------------------------------------------------

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
  window.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...e.dataTransfer.files].filter((f) => /\.(pdf|png|jpe?g)$/i.test(f.name));
    if (!files.length) return toast("Solte arquivos PDF ou imagens.");
    await openFiles(await Promise.all(files.map(platform.fileFromBrowser)));
  });
}

function readRecent() {
  try {
    return JSON.parse(localStorage.getItem("recentFiles") || "[]");
  } catch {
    return [];
  }
}

function writeRecent(list) {
  try {
    localStorage.setItem("recentFiles", JSON.stringify(list.slice(0, 10)));
  } catch {
    // Sem armazenamento: a lista não é guardada.
  }
}

function addRecent({ name, path }) {
  if (!path) return;
  writeRecent([{ name, path, time: Date.now() }, ...readRecent().filter((r) => r.path !== path)]);
  platform.addRecentDocument(path);
}

function renderRecent() {
  // Arrastar arquivos para a janela não existe no celular.
  $("#welcome-drop").hidden = platform.isAndroid;
  const list = readRecent();
  const section = $("#recent-section");
  section.hidden = !platform.isDesktop || !list.length;
  if (section.hidden) return;
  $("#recent-list").replaceChildren(
    ...list.map((item) =>
      el("li", {}, [
        el(
          "button",
          {
            class: "recent-open",
            title: item.path,
            onclick: async () => {
              try {
                const file = await platform.readPath(item.path);
                // Recente de antes desta versão: a pessoa não confirmou o arquivo.
                if (!file) return;
                await openDocument(file.data, { name: file.name, path: file.path });
              } catch {
                writeRecent(readRecent().filter((r) => r.path !== item.path));
                renderRecent();
                toast("Esse arquivo não foi encontrado. Ele pode ter sido movido ou excluído.");
              }
            },
          },
          [el("span", { text: item.name }), el("span", { class: "muted", text: item.path.replace(/[\\/][^\\/]*$/, "") })],
        ),
        el("button", {
          class: "btn icon-only small",
          title: "Remover da lista",
          text: "×",
          onclick: () => {
            writeRecent(readRecent().filter((r) => r.path !== item.path));
            renderRecent();
          },
        }),
      ]),
    ),
  );
}

function registerServiceWorker() {
  // O app Android já tem tudo dentro dele (e um cache antigo atrapalharia a atualização).
  if (platform.isDesktop || platform.isAndroid || !("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

setupToolbar();
setupDragAndDrop();
const checkForUpdates = setupUpdates({ closeDocuments: closeUnsaved });
document.addEventListener("keydown", onKeyDown);
platform.onMenu((action) => runAction(action));
platform.onOpenFile((file) => openFiles([file]));
// Avisos do processo principal (arquivo que não abriu, por exemplo), na janela do app.
platform.onNotice((n) => notice(n));
if (platform.isAndroid) setupAndroid(app);
window.addEventListener("beforeunload", (e) => {
  if (!platform.isDesktop && manager.tabs.some((t) => t.dirty)) e.preventDefault();
});
updateTitle();
registerServiceWorker();
try {
  if (localStorage.getItem("sidebar")) app.sidebar.panel = localStorage.getItem("sidebar");
} catch {
  // Preferência indisponível.
}
const initial = await platform.getInitialFile();
if (initial?.length) await openFiles(initial);

// Usado pelos testes automatizados.
app.runAction = runAction;
window.__app = app;
