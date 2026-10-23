// Abas: cada documento aberto tem o próprio visualizador do PDF.js. Só a aba
// ativa fica visível; as outras mantêm o estado (rolagem, zoom, edições).
import {
  AnnotationEditorType,
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  loadPdf,
} from "./pdfjs.js";
import { $, askText, el, setBusy, toast } from "./ui.js";
import * as security from "./pdf/security.js";

export const HIGHLIGHT_COLORS = "yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F";
const SCALE_PRESETS = new Set(["auto", "page-width", "page-fit", "page-actual"]);
let nextId = 1;

async function askOpenPassword(name, incorrect) {
  setBusy(false);
  return askText({
    title: "Documento protegido",
    label: incorrect ? "Senha incorreta. Tente novamente." : `Digite a senha para abrir "${name}".`,
    password: true,
    ok: "Abrir",
  });
}

export class DocTab {
  constructor(manager, { name, path }) {
    this.manager = manager;
    this.id = nextId++;
    this.name = name;
    this.path = path;
    this.dirty = false;
    this.doc = null;
    this.password = null;
    this.encrypted = false;
    this.owner = true;
    this.security = null;
    this.encInfo = null;
    this.pendingView = null;
    this.pageCache = new Map();
    this.loaded = Promise.resolve();

    this.container = el("div", { class: "viewer-container", tabindex: "0", hidden: true }, el("div", { class: "pdfViewer" }));
    manager.area.prepend(this.container);
    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({ eventBus: this.eventBus, externalLinkTarget: LinkTarget.BLANK });
    this.findController = new PDFFindController({ eventBus: this.eventBus, linkService: this.linkService });
    this.viewer = new PDFViewer({
      container: this.container,
      viewer: this.container.firstChild,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      annotationEditorMode: AnnotationEditorType.NONE,
      annotationEditorHighlightColors: HIGHLIGHT_COLORS,
      imageResourcesPath: "./pdfjs/images/",
    });
    this.linkService.setViewer(this.viewer);
    this.bindEvents();
  }

  get active() {
    return this.manager.active === this;
  }

  bindEvents() {
    const bus = this.eventBus;
    const emit = (name, ...args) => this.manager.emit(name, this, ...args);
    bus.on("pagesinit", () => {
      // Aba aberta em segundo plano: aplica zoom e posição quando for exibida.
      if (this.container.hidden) this.initPending = true;
      else this.applyInitialView();
    });
    bus.on("pagesloaded", () => {
      if (this.initPending) this.loadedPending = true;
      else this.finishLoad();
    });
    bus.on("pagechanging", ({ pageNumber }) => emit("pagechange", pageNumber));
    bus.on("scalechanging", (e) => emit("scalechange", e));
    bus.on("updatefindmatchescount", ({ matchesCount }) => emit("findcount", matchesCount));
    bus.on("updatefindcontrolstate", (e) => emit("findstate", e));
    bus.on("pagerendered", (e) => emit("pagerendered", e));
    this.container.addEventListener("copy", (e) => {
      if (!this.allowed(security.Perm.COPY)) {
        e.preventDefault();
        toast("O autor deste documento não permite copiar o texto.");
      }
    });
  }

  applyInitialView() {
    this.initPending = false;
    const view = this.pendingView;
    this.viewer.currentScaleValue = view?.scaleValue || "auto";
    if (view?.page) this.viewer.currentPageNumber = Math.min(view.page, this.viewer.pagesCount);
    this.manager.emit("ready", this);
    if (this.loadedPending) {
      this.loadedPending = false;
      this.finishLoad();
    }
  }

  finishLoad() {
    const view = this.pendingView;
    this.pendingView = null;
    if (view?.scrollTop != null) {
      this.container.scrollTop = view.scrollTop;
      this.container.scrollLeft = view.scrollLeft;
    }
    this.resolveLoaded?.();
  }

  /** Carrega (ou recarrega) bytes nesta aba. */
  async load(bytes, { password = this.password, ownerPassword = this.security?.ownerPassword, view = null } = {}) {
    const { doc, password: used } = await loadPdf(bytes, {
      password,
      onPassword: (incorrect) => askOpenPassword(this.name, incorrect),
    });
    const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
    const previous = this.doc;
    this.doc = doc;
    this.password = used;
    this.encrypted = Boolean(info?.EncryptFilterName);
    this.size = bytes.length;
    await this.updateSecurity(bytes, used, ownerPassword);
    this.pendingView = view;
    this.pageCache.clear();
    doc.annotationStorage.onSetModified = () => this.setDirty(true);
    // Resolvida quando as páginas carregam e a posição volta (ver finishLoad).
    this.loaded = new Promise((resolve) => (this.resolveLoaded = resolve));
    this.viewer.setDocument(doc);
    this.linkService.setDocument(doc, null);
    previous?.destroy();
    this.container.classList.toggle("no-copy", !this.allowed(security.Perm.COPY));
    this.manager.emit("loaded", this);
  }

  async updateSecurity(bytes, password, ownerPassword) {
    if (!this.encrypted) {
      this.security = null;
      this.encInfo = null;
      this.owner = true;
      return;
    }
    const info = await security.readEncryption(bytes);
    this.encInfo = info;
    ({ owner: this.owner, security: this.security } = security.sessionSecurity(info, password, ownerPassword));
  }

  /** A ação é permitida pelas restrições do documento? */
  allowed(flag) {
    return !this.encrypted || this.owner || (this.security.P & flag) !== 0;
  }

  /** Garante a permissão, pedindo a senha de permissões se preciso. */
  async requestPermission(flag, what) {
    if (this.allowed(flag)) return true;
    return this.requestOwner(what);
  }

  /** Confirma que o usuário tem a senha de permissões (proprietário). */
  async requestOwner(what) {
    if (!this.encrypted || this.owner) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const pw = await askText({
        title: "Documento com restrições",
        label: `${attempt ? "Senha incorreta. " : ""}O autor deste documento não permite ${what}. Digite a senha de permissões para continuar.`,
        password: true,
        ok: "Liberar",
      });
      if (pw === null) return false;
      if (security.isOwnerPassword(this.encInfo, pw)) {
        this.owner = true;
        this.security.ownerPassword = pw;
        this.container.classList.remove("no-copy");
        toast("Restrições liberadas para esta sessão.");
        return true;
      }
    }
    toast("Senha de permissões incorreta.");
    return false;
  }

  setDirty(dirty) {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.manager.emit("dirty", this);
  }

  captureView() {
    return {
      page: this.viewer.currentPageNumber,
      scaleValue: this.viewer.currentScaleValue,
      scrollTop: this.container.scrollTop,
      scrollLeft: this.container.scrollLeft,
    };
  }

  /** Bytes atuais, incluindo anotações e campos de formulário editados. */
  async currentBytes() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.container.contains(active)) active.blur();
    await new Promise((r) => setTimeout(r, 0));
    return this.doc.annotationStorage.size > 0 ? this.doc.saveDocument() : this.doc.getData();
  }

  /** Abre os bytes atuais com pdf-lib (decifrando se preciso). */
  async loadEditable() {
    return security.loadForEdit(await this.currentBytes(), this.encrypted ? this.security : null);
  }

  /**
   * Aplica uma alteração com pdf-lib e recarrega. `keepView` preserva zoom e
   * rolagem; `page` posiciona numa página (usado ao reorganizar páginas).
   */
  async edit(fn, { keepView = true, page = null } = {}) {
    const before = await this.currentBytes();
    const pdf = await security.loadForEdit(before, this.encrypted ? this.security : null);
    const result = await fn(pdf);
    const out = await security.saveFromEdit(pdf, this.encrypted ? this.security : null);
    await this.replace(out, { keepView, page, previous: before });
    return result;
  }

  /**
   * Troca o conteúdo da aba por novos bytes (marca como alterado). O estado
   * anterior vai para o histórico de "Desfazer".
   */
  async replace(bytes, { keepView = true, page = null, dirty = true, password, ownerPassword, previous, history = true } = {}) {
    if (history) this.pushHistory(previous ?? (await this.currentBytes()));
    const view = keepView
      ? this.captureView()
      : { page: page ?? this.viewer.currentPageNumber, scaleValue: this.viewer.currentScaleValue };
    if (page) view.page = page;
    await this.load(bytes, {
      password: password ?? this.security?.userPassword ?? this.password,
      ownerPassword: ownerPassword !== undefined ? ownerPassword : this.security?.ownerPassword,
      view,
    });
    this.setDirty(dirty);
  }

  /** Grava no arquivo as anotações feitas com as ferramentas do PDF.js. */
  async commitEditors() {
    if (!this.doc || this.doc.annotationStorage.size === 0) return;
    const bytes = await this.currentBytes();
    await this.replace(bytes, { keepView: true, history: false });
  }

  pushHistory(bytes) {
    this.history ||= [];
    this.history.push(bytes);
    this.future = [];
    // Limita a memória usada pelo histórico (~150 MB ou 30 passos).
    let total = this.history.reduce((sum, b) => sum + b.length, 0);
    while (this.history.length > 1 && (this.history.length > 30 || total > 150 * 1024 * 1024)) {
      total -= this.history.shift().length;
    }
  }

  get canUndo() {
    return Boolean(this.history?.length);
  }

  get canRedo() {
    return Boolean(this.future?.length);
  }

  async undo() {
    if (!this.canUndo) return false;
    const current = await this.currentBytes();
    const previous = this.history.pop();
    this.future.push(current);
    await this.load(previous, { password: this.security?.userPassword ?? this.password, view: this.captureView() });
    this.setDirty(true);
    return true;
  }

  async redo() {
    if (!this.canRedo) return false;
    const current = await this.currentBytes();
    const next = this.future.pop();
    this.history.push(current);
    await this.load(next, { password: this.security?.userPassword ?? this.password, view: this.captureView() });
    this.setDirty(true);
    return true;
  }

  show() {
    this.container.hidden = false;
    if (this.initPending) this.applyInitialView();
    else this.refreshLayout();
  }

  hide() {
    this.container.hidden = true;
  }

  refreshLayout() {
    if (!this.doc) return;
    const value = this.viewer.currentScaleValue;
    if (SCALE_PRESETS.has(value)) this.viewer.currentScaleValue = value;
    this.viewer.update();
  }

  pageView(pageNumber) {
    return this.viewer.getPageView(pageNumber - 1);
  }

  destroy() {
    try {
      this.viewer.setDocument(null);
    } catch {
      // O visualizador já pode ter sido descartado.
    }
    this.doc?.destroy();
    this.container.remove();
  }
}

export class TabManager {
  constructor(area, tabbar) {
    this.area = area;
    this.tabbar = tabbar;
    this.tabs = [];
    this.active = null;
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.listeners.get(event) || []) fn(...args);
  }

  findByPath(path) {
    return path ? this.tabs.find((t) => t.path === path) : null;
  }

  async open(bytes, { name, path = null, dirty = false, password } = {}) {
    const existing = this.findByPath(path);
    if (existing) {
      this.activate(existing);
      return existing;
    }
    const tab = new DocTab(this, { name, path });
    this.tabs.push(tab);
    this.activate(tab);
    try {
      await tab.load(bytes, { password });
    } catch (err) {
      this.remove(tab);
      throw err;
    }
    tab.setDirty(dirty);
    this.render();
    return tab;
  }

  activate(tab) {
    if (!tab) return;
    const previous = this.active;
    this.active = tab;
    for (const t of this.tabs) if (t !== tab) t.hide();
    tab.show();
    this.render();
    if (previous !== tab) this.emit("activate", tab, previous);
  }

  remove(tab) {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    tab.destroy();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      if (next) this.activate(next);
      else this.emit("activate", null, tab);
    }
    this.render();
  }

  cycle(step) {
    if (this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length]);
  }

  render() {
    const list = $(".tab-list", this.tabbar);
    list.replaceChildren(
      ...this.tabs.map((tab) =>
        el(
          "div",
          {
            class: `tab${tab === this.active ? " active" : ""}${tab.dirty ? " dirty" : ""}`,
            role: "tab",
            "aria-selected": String(tab === this.active),
            title: tab.path || tab.name,
            dataset: { tabId: tab.id },
            onclick: () => this.activate(tab),
            onauxclick: (e) => e.button === 1 && this.emit("closerequest", tab),
          },
          [
            el("span", { class: "tab-dot", "aria-hidden": "true" }),
            el("span", { class: "tab-name", text: tab.name }),
            el("button", {
              class: "tab-close",
              title: "Fechar (Ctrl+W)",
              "aria-label": `Fechar ${tab.name}`,
              text: "×",
              onclick: (e) => {
                e.stopPropagation();
                this.emit("closerequest", tab);
              },
            }),
          ],
        ),
      ),
    );
  }
}
