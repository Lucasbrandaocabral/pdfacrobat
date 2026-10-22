// Ferramentas de interação com a página: as do próprio PDF.js (destacar,
// texto, desenho, imagem) e as nossas (sublinhar, tachar, nota, formas,
// carimbo, assinatura, marcas do "Preencher e assinar" e edição de
// texto/imagens).
import { PDFDocument } from "@cantoo/pdf-lib";
import { AnnotationEditorParamsType, AnnotationEditorType, fontInfo, getTextItems, loadPdf, pdfjsLib } from "./pdfjs.js";
import { $, $$, askText, el, hexToRgb, rgbToHex, toast } from "./ui.js";
import { icon } from "./icons.js";
import * as annotations from "./pdf/annotations.js";
import { findImages, imageHasMask, isolatePage, moveImage, readPageContent, removeImage } from "./pdf/content.js";
import { drawPngOnPage } from "./pdf/ops.js";
import { drawMark, today } from "./pdf/fill.js";
import { LINE_HEIGHT, addText, describeLine, editBlock, editText, fontStyle, groupLines, groupParagraphs } from "./pdf/textedit.js";
import { baseFontName, findTextRuns, lineRuns, removeRuns } from "./pdf/textops.js";
import { catalogFont, cssFamily, exactFamily, fallbackFont, fontById, loadFontFace, matchFont, rememberFont } from "./fonts.js";
import { closeFontPicker, fontPickerOpen, openFontPicker } from "./fontpicker.js";
import { Perm, loadForEdit } from "./pdf/security.js";
import * as platform from "./platform.js";

const NONE = AnnotationEditorType.NONE;
const EDITOR_MODES = {
  select: NONE,
  highlight: AnnotationEditorType.HIGHLIGHT,
  text: AnnotationEditorType.FREETEXT,
  ink: AnnotationEditorType.INK,
  image: AnnotationEditorType.STAMP,
};
const PERMISSIONS = {
  highlight: [Perm.ANNOTATE, "comentar"],
  underline: [Perm.ANNOTATE, "comentar"],
  strike: [Perm.ANNOTATE, "comentar"],
  note: [Perm.ANNOTATE, "comentar"],
  text: [Perm.ANNOTATE, "comentar"],
  ink: [Perm.ANNOTATE, "comentar"],
  shape: [Perm.ANNOTATE, "comentar"],
  stamp: [Perm.ANNOTATE, "comentar"],
  image: [Perm.ANNOTATE, "adicionar imagens"],
  sign: [Perm.MODIFY, "assinar"],
  mark: [Perm.MODIFY, "preencher"],
  edit: [Perm.MODIFY, "editar o conteúdo"],
  addtext: [Perm.MODIFY, "escrever no documento"],
};
const PLACING = new Set(["sign", "stamp", "mark"]);
// Tamanhos do "Preencher e assinar" (pequeno, médio, grande), em pontos do PDF:
// caixa máxima da assinatura e das iniciais, lado das marcas e letra da data.
const FILL_SIZES = {
  signature: { small: [125, 36], medium: [180, 50], large: [250, 70] },
  initials: { small: [45, 24], medium: [65, 34], large: [90, 48] },
  mark: { small: 10, medium: 14, large: 20 },
  date: { small: 9, medium: 11, large: 14 },
};
const FILL_INKS = { black: [0.07, 0.07, 0.07], blue: [0.04, 0.12, 0.4] };
const MARK_SVG = {
  check: '<path d="M-38 0 L-10 30 L40 -36" />',
  cross: '<path d="M-32 -32 L32 32 M32 -32 L-32 32" />',
  dot: '<circle r="20" stroke="none" fill="currentColor" />',
};
const ALL_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const SHAPE_ICONS = { rect: "rect", ellipse: "ellipse", line: "line", arrow: "arrow" };
const SHAPE_LABELS = { rect: "Retângulo", ellipse: "Elipse", line: "Linha", arrow: "Seta" };

export class ToolController {
  /** `run(label, task)` executa com indicador de progresso; `guard(tab, flag, what)` checa permissões. */
  constructor(manager, { run, guard }) {
    this.manager = manager;
    this.run = run;
    this.guard = guard;
    this.tool = "select";
    this.shape = "rect";
    this.stamp = "aprovado";
    this.signature = null;
    this.mark = "check";
    this.fillSize = "medium";
    this.fillInk = "black";
    this.drag = null;
    this.editing = null;
    this.hoverFrame = 0;
    this.area = $("#viewer-area");
    this.ghost = $("#place-ghost");

    this.buildStampMenu();
    this.bindEvents();
    manager.on("ready", (tab) => {
      if (tab.active) this.applyEditorMode(tab);
    });
    manager.on("activate", () => this.apply("select"));
    manager.on("scalechange", (tab) => tab.active && this.followZoom());
    // Recarregar o documento recria as páginas: a edição aberta nele se perde.
    manager.on("loaded", (tab) => this.editing?.hit.tab === tab && this.clearEdit());
  }

  get tab() {
    return this.manager.active;
  }

  // ---- Seleção de ferramenta ----

  async select(tool) {
    const tab = this.tab;
    if (!tab?.doc) return;
    const perm = PERMISSIONS[tool];
    if (perm && !(await this.guard(tab, perm[0], perm[1]))) return;
    if (tool === "sign" && !this.signature) return;
    this.finishEdit();
    this.apply(tool);
    if (tool === "image") this.setEditorParam(AnnotationEditorParamsType.CREATE, null);
  }

  /** Começa a posicionar a assinatura (ou as iniciais), criada agora ou salva. */
  async startSignature(signature) {
    const tab = this.tab;
    if (!tab?.doc || !(await this.guard(tab, ...PERMISSIONS.sign))) return;
    this.finishEdit();
    this.signature = signature;
    this.apply("sign");
  }

  /** Marca do "Preencher e assinar": check, cross, dot ou date. */
  setMark(kind) {
    this.mark = kind;
    this.select("mark");
  }

  /**
   * Pede um clique numa página (ex.: posição da assinatura digital). Resolve
   * com a posição ou null se cancelado com Esc. `size` em pontos do PDF.
   */
  pickPoint({ label, size }) {
    this.apply("select");
    return new Promise((resolve) => {
      this.pending = { label, size, resolve };
      this.area.classList.add("mode-place");
      toast("Clique na página onde a assinatura vai ficar (Esc cancela).", { duration: 5000 });
    });
  }

  resolvePending(value) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.ghost.hidden = true;
    this.area.classList.remove("mode-place");
    pending.resolve(value);
  }

  apply(tool) {
    this.resolvePending(null);
    this.tool = tool;
    $$("[data-tool]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === tool);
      b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    });
    $$("[data-mark]").forEach((b) => b.classList.toggle("active", tool === "mark" && b.dataset.mark === this.mark));
    $$('[data-action="sign"], [data-action="sign-initials"]').forEach((b) =>
      b.classList.toggle("active", tool === "sign" && (this.signature?.kind === "initials") === (b.dataset.action === "sign-initials")),
    );
    $$("#tool-options .opt").forEach((o) => (o.hidden = !o.dataset.for.split(" ").includes(tool)));
    this.area.classList.toggle("mode-place", PLACING.has(tool));
    this.area.classList.toggle("mode-note", tool === "note");
    this.area.classList.toggle("mode-shape", tool === "shape");
    this.area.classList.toggle("mode-edit", tool === "edit");
    this.area.classList.toggle("mode-addtext", tool === "addtext");
    if (tool !== "sign") this.signature = null;
    this.ghost.hidden = true;
    this.ghost.dataset.kind = "";
    this.cancelDrag();
    if (tool !== "edit" || this.editing?.kind === "signature") this.finishEdit();
    if (this.tab?.doc) this.applyEditorMode(this.tab);
  }

  applyEditorMode(tab) {
    try {
      tab.viewer.annotationEditorMode = { mode: EDITOR_MODES[this.tool] ?? NONE };
    } catch {
      // O visualizador ainda não terminou de carregar; reaplicado em "ready".
    }
    this.applyParams();
  }

  setEditorParam(type, value) {
    this.tab?.eventBus.dispatch("switchannotationeditorparams", { source: window, type, value });
  }

  applyParams() {
    const color = $("#opt-color").value;
    this.setEditorParam(AnnotationEditorParamsType.INK_COLOR, color);
    this.setEditorParam(AnnotationEditorParamsType.FREETEXT_COLOR, color);
    this.setEditorParam(AnnotationEditorParamsType.INK_THICKNESS, Number($("#opt-thickness").value));
    this.setEditorParam(AnnotationEditorParamsType.FREETEXT_SIZE, Number($("#opt-font-size").value));
    this.setEditorParam(AnnotationEditorParamsType.HIGHLIGHT_DEFAULT_COLOR, $("#opt-highlight").value);
  }

  setShape(shape) {
    this.shape = shape;
    const button = $("#shape-button");
    button.querySelector(".icon").outerHTML = icon(SHAPE_ICONS[shape]);
    button.querySelector("span").textContent = SHAPE_LABELS[shape];
    this.select("shape");
  }

  setStamp(stamp) {
    this.stamp = stamp;
    this.select("stamp");
  }

  buildStampMenu() {
    const menu = $("#stamp-menu");
    for (const [key, stamp] of Object.entries(annotations.STAMPS)) {
      const [r, g, b] = stamp.color.map((v) => Math.round(v * 255));
      menu.append(
        el("button", { role: "menuitem", dataset: { stamp: key } }, [
          el("span", { class: "stamp-chip", text: stamp.label, style: `color: rgb(${r}, ${g}, ${b})` }),
        ]),
      );
    }
  }

  // ---- Utilidades de página ----

  /** Página sob o evento, com a posição em CSS e em coordenadas do PDF. */
  pageHit(e) {
    const tab = this.tab;
    const pageDiv = e.target?.closest?.(".page");
    if (!tab || !pageDiv || !tab.container.contains(pageDiv)) return null;
    return this.hitFromPage(tab, pageDiv, e.clientX, e.clientY);
  }

  hitFromPage(tab, pageDiv, clientX, clientY) {
    const pageNumber = Number(pageDiv.dataset.pageNumber);
    const pageView = tab.pageView(pageNumber);
    if (!pageView?.viewport) return null;
    const wrapper = pageDiv.querySelector(".canvasWrapper") || pageDiv;
    const rect = wrapper.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return {
      tab,
      pageDiv,
      wrapper,
      pageNumber,
      pageIndex: pageNumber - 1,
      pageView,
      rect,
      x,
      y,
      pdf: pageView.viewport.convertToPdfPoint(x, y),
      scale: pageView.viewport.scale,
      rotation: pageView.pdfPage?.rotate ?? 0,
    };
  }

  /** Camada de desenho temporário sobre a página (mesmo tamanho do canvas). */
  overlayFor(hit) {
    let layer = hit.pageDiv.querySelector(":scope > .overlay-layer");
    if (!layer) {
      layer = el("div", { class: "overlay-layer" });
      hit.pageDiv.append(layer);
    }
    Object.assign(layer.style, {
      left: `${hit.wrapper.offsetLeft}px`,
      top: `${hit.wrapper.offsetTop}px`,
      width: `${hit.wrapper.offsetWidth}px`,
      height: `${hit.wrapper.offsetHeight}px`,
      right: "auto",
      bottom: "auto",
    });
    return layer;
  }

  /** Retângulo do PDF -> {left, top, width, height} em CSS da página. */
  cssRect(pageView, rect) {
    const [x1, y1, x2, y2] = pageView.viewport.convertToViewportRectangle(rect);
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

  author() {
    return platform.getUserName();
  }

  // ---- Eventos ----

  bindEvents() {
    // Na janela, em captura: assim as nossas ferramentas recebem o clique antes
    // dos editores do PDF.js (que também escutam a janela durante um desenho).
    window.addEventListener("pointerdown", (e) => this.onPointerDown(e), true);
    window.addEventListener("pointerup", (e) => this.endOutsideTap(e), true);
    window.addEventListener("pointercancel", () => (this.outsideTap = null), true);
    this.area.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.area.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.area.addEventListener("pointerleave", () => {
      this.ghost.hidden = true;
      this.removeHover();
    });
    document.addEventListener("keydown", (e) => this.onKeyDown(e), true);

    ["#opt-color", "#opt-thickness", "#opt-font-size", "#opt-highlight"].forEach((id) =>
      $(id).addEventListener("input", () => this.applyParams()),
    );
    $("#opt-fill-size").addEventListener("change", (e) => (this.fillSize = e.target.value));
    $("#opt-fill-ink").addEventListener("change", (e) => (this.fillInk = e.target.value));
  }

  onKeyDown(e) {
    // Com uma janela ou menu aberto por cima, as teclas são dele (o Esc fecha o
    // menu, não descarta a assinatura na caixa).
    if (document.querySelector("dialog[open], .menu:not([hidden]), .font-picker")) return;
    if (e.key === "Escape" && this.pending) {
      e.preventDefault();
      this.resolvePending(null);
      return;
    }
    // Digitando num campo (pesquisa, número da página, formulário): a tecla é dele.
    const field = e.target.closest?.("input, textarea, select");
    if (e.key === "Escape") {
      if (this.editing && !field) {
        // Só desfaz a edição aberta: a ferramenta continua escolhida.
        e.preventDefault();
        e.stopPropagation();
        this.clearEdit();
      } else if (this.drag) {
        this.cancelDrag();
      }
      return;
    }
    const box = this.editing?.kind === "image" || this.editing?.kind === "signature";
    if (box && !field && !e.target.closest?.("[contenteditable]")) {
      const signature = this.editing.kind === "signature";
      const step = e.shiftKey ? 10 : 1;
      const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (nudge) {
        e.preventDefault();
        e.stopPropagation();
        this.editing.rect = this.clampToPage({ ...this.editing.rect, left: this.editing.rect.left + nudge[0], top: this.editing.rect.top + nudge[1] });
        this.layoutImageBox();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (signature) this.clearEdit();
        else this.deleteImage();
      } else if (e.key === "Enter" && !e.target.closest?.(".float-bar")) {
        e.preventDefault();
        this.finishEdit();
      }
    }
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    if (this.pending) {
      const hit = this.pageHit(e);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        this.resolvePending(hit);
      }
      return;
    }
    if (this.editing?.kind === "signature") {
      // Tocar ou clicar na página fora da assinatura conclui; quem decide na
      // barra de ferramentas é a própria ação (zoom, por exemplo, não conclui).
      if (this.area.contains(e.target) && !e.target.closest?.(".image-box, .float-bar") && !onScrollbar(e)) {
        this.outsideTap = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
      return;
    }
    const tool = this.tool;
    if (!["note", "shape", "sign", "stamp", "mark", "edit", "addtext"].includes(tool)) return;
    const editTool = tool === "edit" || tool === "addtext";
    if (editTool && e.target.closest?.(".text-box, .image-box, .float-bar, .font-picker")) return;
    const hit = this.pageHit(e);
    if (!hit) {
      if (editTool && this.area.contains(e.target)) this.finishEdit();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (tool === "note") this.addNote(hit);
    else if (tool === "shape") this.startShape(e, hit);
    else if (tool === "sign") this.placeSignature(hit);
    else if (tool === "stamp") this.placeStamp(hit);
    else if (tool === "mark") this.placeMark(hit);
    else if (tool === "addtext") this.addTextAt(hit);
    else this.editAt(hit);
  }

  /** Só conclui no fim de um toque sem arrastar: rolar a página com o dedo não conta. */
  endOutsideTap(e) {
    const tap = this.outsideTap;
    this.outsideTap = null;
    if (tap?.id !== e.pointerId || this.editing?.kind !== "signature") return;
    if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10) this.commitSignature();
  }

  onPointerMove(e) {
    if (this.drag) {
      this.updateShape(e);
      return;
    }
    if (this.pending) this.movePendingGhost(e);
    else if (PLACING.has(this.tool)) this.moveGhost(e);
    else if (this.tool === "edit" && !this.editing) {
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = requestAnimationFrame(() => this.updateHover(e));
    }
  }

  onPointerUp(e) {
    if (this.drag) {
      this.finishShape(e);
      return;
    }
    if (this.tool === "underline" || this.tool === "strike") {
      setTimeout(() => this.markSelection(this.tool === "underline" ? "Underline" : "StrikeOut"), 0);
    }
  }

  // ---- Sublinhar / tachar ----

  pageAtPoint(tab, x, y) {
    for (const pageDiv of tab.container.querySelectorAll(".page")) {
      const wrapper = pageDiv.querySelector(".canvasWrapper") || pageDiv;
      const r = wrapper.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return pageDiv;
    }
    return null;
  }

  async markSelection(kind) {
    const tab = this.tab;
    const selection = window.getSelection();
    if (!tab || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!tab.container.contains(range.commonAncestorContainer)) return;
    const pages = new Map();
    for (const r of range.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const pageDiv = this.pageAtPoint(tab, r.left + r.width / 2, r.top + r.height / 2);
      if (!pageDiv) continue;
      const hit = this.hitFromPage(tab, pageDiv, r.left, r.top);
      if (!hit) continue;
      // Ignora retângulos que cobrem quase a página inteira (fim da camada de texto).
      if (r.width * r.height > hit.rect.width * hit.rect.height * 0.3) continue;
      const vp = hit.pageView.viewport;
      const a = vp.convertToPdfPoint(r.left - hit.rect.left, r.bottom - hit.rect.top);
      const b = vp.convertToPdfPoint(r.right - hit.rect.left, r.top - hit.rect.top);
      const quad = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      if (!pages.has(hit.pageIndex)) pages.set(hit.pageIndex, { rotation: hit.rotation, quads: [] });
      pages.get(hit.pageIndex).quads.push(quad);
    }
    if (!pages.size) return;
    selection.removeAllRanges();
    const color = hexToRgb($("#opt-color").value);
    const author = await this.author();
    await this.run(kind === "Underline" ? "Sublinhando…" : "Tachando…", () =>
      tab.edit((doc) => {
        for (const [pageIndex, { rotation, quads }] of pages) {
          annotations.addTextMarkup(doc, pageIndex, { kind, quads: mergeQuads(quads, rotation), color, author, rotation });
        }
      }),
    );
  }

  // ---- Nota ----

  async addNote(hit) {
    const contents = await askText({ title: "Nova nota", label: "Texto da nota", multiline: true, ok: "Adicionar" });
    if (!contents?.trim()) return;
    const author = await this.author();
    await this.run("Adicionando nota…", () =>
      hit.tab.edit((doc) => annotations.addNote(doc, hit.pageIndex, { point: hit.pdf, contents: contents.trim(), author })),
    );
  }

  // ---- Formas ----

  startShape(e, hit) {
    const layer = this.overlayFor(hit);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("shape-preview");
    layer.append(svg);
    this.drag = { hit, start: [hit.x, hit.y], end: [hit.x, hit.y], svg, pointerId: e.pointerId };
    try {
      this.area.setPointerCapture(e.pointerId);
    } catch {
      // Sem captura: o arrasto ainda funciona dentro da página.
    }
    this.updateShape(e);
  }

  shapeEnd(e) {
    const { hit, start } = this.drag;
    const rect = hit.wrapper.getBoundingClientRect();
    let x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    let y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    if (e.shiftKey) {
      const dx = x - start[0];
      const dy = y - start[1];
      if (this.shape === "rect" || this.shape === "ellipse") {
        const size = Math.max(Math.abs(dx), Math.abs(dy));
        x = start[0] + Math.sign(dx || 1) * size;
        y = start[1] + Math.sign(dy || 1) * size;
      } else {
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x = start[0] + Math.cos(angle) * len;
        y = start[1] + Math.sin(angle) * len;
      }
    }
    return [x, y];
  }

  updateShape(e) {
    if (!this.drag) return;
    const end = this.shapeEnd(e);
    this.drag.end = end;
    const [x0, y0] = this.drag.start;
    const [x1, y1] = end;
    const color = $("#opt-color").value;
    const width = Number($("#opt-thickness").value) * this.drag.hit.scale;
    const ns = "http://www.w3.org/2000/svg";
    const svg = this.drag.svg;
    svg.replaceChildren();
    const shape = document.createElementNS(ns, this.shape === "rect" ? "rect" : this.shape === "ellipse" ? "ellipse" : "path");
    if (this.shape === "rect") {
      shape.setAttribute("x", Math.min(x0, x1));
      shape.setAttribute("y", Math.min(y0, y1));
      shape.setAttribute("width", Math.abs(x1 - x0));
      shape.setAttribute("height", Math.abs(y1 - y0));
    } else if (this.shape === "ellipse") {
      shape.setAttribute("cx", (x0 + x1) / 2);
      shape.setAttribute("cy", (y0 + y1) / 2);
      shape.setAttribute("rx", Math.abs(x1 - x0) / 2);
      shape.setAttribute("ry", Math.abs(y1 - y0) / 2);
    } else {
      let d = `M${x0},${y0} L${x1},${y1}`;
      if (this.shape === "arrow") {
        const head = Math.max(8, Number($("#opt-thickness").value) * 4) * this.drag.hit.scale;
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const p1 = [x1 - head * Math.cos(angle - Math.PI / 7), y1 - head * Math.sin(angle - Math.PI / 7)];
        const p2 = [x1 - head * Math.cos(angle + Math.PI / 7), y1 - head * Math.sin(angle + Math.PI / 7)];
        d += ` M${p1} L${x1},${y1} L${p2}`;
      }
      shape.setAttribute("d", d);
    }
    shape.setAttribute("fill", "none");
    shape.setAttribute("stroke", color);
    shape.setAttribute("stroke-width", width);
    shape.setAttribute("stroke-linecap", "round");
    shape.setAttribute("stroke-linejoin", "round");
    svg.append(shape);
  }

  async finishShape(e) {
    const drag = this.drag;
    this.updateShape(e);
    this.cancelDrag();
    const { hit, start, end } = drag;
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 4) return;
    const vp = hit.pageView.viewport;
    const a = vp.convertToPdfPoint(...start);
    const b = vp.convertToPdfPoint(...end);
    const color = hexToRgb($("#opt-color").value);
    const width = Number($("#opt-thickness").value);
    const author = await this.author();
    await this.run("Desenhando…", () =>
      hit.tab.edit((doc) =>
        annotations.addShape(doc, hit.pageIndex, { kind: this.shape, points: [...a, ...b], color, width, author }),
      ),
    );
  }

  cancelDrag() {
    if (!this.drag) return;
    try {
      this.area.releasePointerCapture(this.drag.pointerId);
    } catch {
      // Captura já liberada.
    }
    this.drag.svg.remove();
    this.drag = null;
  }

  // ---- Posicionar assinatura ou carimbo ----

  ghostSize(scale) {
    if (this.tool === "sign" && this.signature) {
      const { aspect, kind } = this.signature;
      const [maxW, maxH] = FILL_SIZES[kind === "initials" ? "initials" : "signature"][this.fillSize];
      const w = Math.min(maxW, maxH * aspect);
      return [w * scale, (w / aspect) * scale];
    }
    if (this.tool === "mark") {
      if (this.mark === "date") {
        const size = FILL_SIZES.date[this.fillSize];
        const ctx = (this.measure ||= document.createElement("canvas").getContext("2d"));
        ctx.font = `${size}px Helvetica, Arial, sans-serif`;
        return [ctx.measureText(today()).width * scale, size * 1.2 * scale];
      }
      const side = FILL_SIZES.mark[this.fillSize] * scale;
      return [side, side];
    }
    const stamp = annotations.STAMPS[this.stamp];
    const ctx = (this.measure ||= document.createElement("canvas").getContext("2d"));
    ctx.font = "bold 18px Helvetica, Arial, sans-serif";
    const w = Math.max(ctx.measureText(stamp.label).width, 120) + 24;
    return [w * scale, 42 * scale];
  }

  moveGhost(e) {
    const hit = this.pageHit(e);
    if (!hit) {
      this.ghost.hidden = true;
      return;
    }
    const [w, h] = this.ghostSize(hit.scale);
    const ghost = this.ghost;
    if (this.tool === "sign") {
      ghost.className = "place-ghost";
      if (ghost.dataset.kind !== "sign") {
        ghost.replaceChildren(el("img", { src: this.signature.previewUrl, alt: "" }));
        ghost.dataset.kind = "sign";
      }
      ghost.style.color = "";
    } else if (this.tool === "mark") {
      const [r, g, b] = FILL_INKS[this.fillInk].map((v) => Math.round(v * 255));
      ghost.className = "place-ghost mark-ghost";
      ghost.style.color = `rgb(${r}, ${g}, ${b})`;
      const kind = `mark-${this.mark}-${this.fillSize}`;
      if (ghost.dataset.kind !== kind) {
        ghost.dataset.kind = kind;
        if (this.mark === "date") ghost.replaceChildren(el("span", { text: today() }));
        else {
          ghost.innerHTML = `<svg viewBox="-50 -50 100 100" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">${MARK_SVG[this.mark]}</svg>`;
        }
      }
      ghost.style.fontSize = `${FILL_SIZES.date[this.fillSize] * hit.scale}px`;
    } else {
      const stamp = annotations.STAMPS[this.stamp];
      ghost.className = "place-ghost stamp-ghost";
      ghost.dataset.kind = `stamp-${this.stamp}`;
      ghost.replaceChildren(stamp.label, el("small", { text: "carimbo" }));
      const [r, g, b] = stamp.color.map((v) => Math.round(v * 255));
      ghost.style.color = `rgb(${r}, ${g}, ${b})`;
      ghost.style.fontSize = `${18 * hit.scale}px`;
    }
    Object.assign(ghost.style, { width: `${w}px`, height: `${h}px`, left: `${e.clientX - w / 2}px`, top: `${e.clientY - h / 2}px` });
    ghost.hidden = false;
  }

  movePendingGhost(e) {
    const hit = this.pageHit(e);
    if (!hit) {
      this.ghost.hidden = true;
      return;
    }
    const [w, h] = this.pending.size.map((v) => v * hit.scale);
    const ghost = this.ghost;
    ghost.className = "place-ghost stamp-ghost";
    ghost.dataset.kind = "pending";
    ghost.replaceChildren(this.pending.label);
    Object.assign(ghost.style, {
      color: "#1a4f99",
      fontSize: `${10 * hit.scale}px`,
      width: `${w}px`,
      height: `${h}px`,
      left: `${e.clientX - w / 2}px`,
      top: `${e.clientY - h / 2}px`,
    });
    ghost.hidden = false;
  }

  /**
   * Põe a assinatura (ou as iniciais) numa caixa ajustável onde foi o clique:
   * dá para arrastar e mudar o tamanho pelos cantos, vendo como vai ficar,
   * antes de aplicar com "Concluir".
   */
  placeSignature(hit) {
    const signature = this.signature;
    if (!signature) return;
    const [w, h] = this.ghostSize(hit.scale);
    this.apply("select");
    const rect = this.clampToLayer(this.overlayFor(hit), { left: hit.x - w / 2, top: hit.y - h / 2, width: w, height: h });
    const label = signature.kind === "initials" ? "as iniciais" : "a assinatura";
    this.openBox(hit, "signature", rect, {
      handles: ["nw", "ne", "se", "sw"],
      preview: el("img", { class: "box-preview", src: signature.previewUrl, alt: "", draggable: "false" }),
      buttons: [
        el("span", { class: "float-hint", text: "Arraste para mover; puxe os cantos para mudar o tamanho" }),
        el("button", { class: "btn", type: "button", title: `Descartar ${label}`, html: `${icon("trash")}<span>Excluir</span>`, onclick: () => this.clearEdit() }),
        el("button", { class: "btn primary", type: "button", text: "Concluir", onclick: () => this.commitSignature() }),
      ],
      extra: { signature },
    });
  }

  /** Aplica na página a assinatura que estava sendo posicionada. */
  commitSignature() {
    const editing = this.editing;
    if (editing?.kind !== "signature") return this.committing;
    const { hit, rect, viewport, signature } = editing;
    this.clearEdit();
    const origin = viewport.convertToPdfPoint(rect.left, rect.top + rect.height);
    const draw = (doc) =>
      drawPngOnPage(doc, {
        pageIndex: hit.pageIndex,
        pngBytes: signature.png,
        origin,
        width: rect.width / viewport.scale,
        height: rect.height / viewport.scale,
        rotation: hit.rotation,
      });
    return this.track(this.run("Aplicando assinatura…", () => hit.tab.edit(draw)));
  }

  async placeMark(hit) {
    const kind = this.mark;
    const size = (kind === "date" ? FILL_SIZES.date : FILL_SIZES.mark)[this.fillSize];
    const color = FILL_INKS[this.fillInk];
    await this.run("Aplicando…", () =>
      hit.tab.edit((doc) => drawMark(doc, { pageIndex: hit.pageIndex, kind, center: hit.pdf, size, color, rotation: hit.rotation })),
    );
  }

  async placeStamp(hit) {
    const stamp = annotations.STAMPS[this.stamp];
    const author = await this.author();
    const subtitle = `${author} · ${annotations.formatDateTime()}`;
    this.apply("select");
    await this.run("Aplicando carimbo…", () =>
      hit.tab.edit((doc) =>
        annotations.addStamp(doc, hit.pageIndex, { stamp, subtitle, center: hit.pdf, rotation: hit.rotation, author }),
      ),
    );
  }

  // ---- Editar texto e imagens ----

  /** O documento da aba no pdf-lib, para ler o conteúdo das páginas (em cache até o próximo recarregamento). */
  libDoc(tab) {
    if (!tab.pageCache.has("lib")) {
      tab.pageCache.set("lib", tab.doc.getData().then((bytes) => loadForEdit(bytes, tab.encrypted ? tab.security : null)));
    }
    return tab.pageCache.get("lib");
  }

  /** Linhas e parágrafos de texto e imagens da página (em cache até o próximo recarregamento). */
  pageData(tab, pageNumber) {
    const key = `edit-${pageNumber}`;
    if (!tab.pageCache.has(key)) {
      const promise = (async () => {
        const page = await tab.doc.getPage(pageNumber);
        // Cópias da mesma fonte (uma por palavra, em alguns PDFs) contam como uma só.
        const fontKey = (name) => baseFontName(fontInfo(page, name).name) || name;
        const lines = groupLines(await getTextItems(page), { fontKey });
        const lib = await this.libDoc(tab);
        const libPage = lib.getPage(pageNumber - 1);
        let content;
        let runs = [];
        let images = [];
        try {
          content = readPageContent(lib, libPage);
          runs = findTextRuns(lib, libPage, content);
        } catch (err) {
          console.warn("Não foi possível ler o texto da página", err);
        }
        try {
          images = findImages(lib, libPage, content);
        } catch (err) {
          console.warn("Não foi possível ler as imagens da página", err);
        }
        const [vx0, vy0, vx1, vy1] = page.view;
        for (const line of lines) {
          // Linha que chega à borda da página: o PDF.js só vê o pedaço de dentro, o resto vem do conteúdo.
          const end = [line.origin[0] + line.width * Math.cos(line.angle), line.origin[1] + line.width * Math.sin(line.angle)];
          line.clipped = end[0] > vx1 - line.size || end[0] < vx0 + line.size || end[1] > vy1 - line.size || end[1] < vy0 + line.size;
          const info = fontInfo(page, line.fontName);
          let drawn = { runs: null, color: null, original: null, spacing: null, text: null };
          try {
            drawn = describeLine(lib, libPage, line, runs);
          } catch (err) {
            console.warn("Não foi possível analisar a linha", err);
          }
          // As fontes da linha carregadas pelo PDF.js, para a prévia ter as letras de todas as cópias.
          const faces = [...new Set(line.fontNames.map((name) => fontInfo(page, name).face).filter(Boolean))];
          Object.assign(line, drawn, { realName: info.name, face: info.face, faces, style: fontStyle(line.fontFamily, info.name) });
        }
        let blocks;
        try {
          blocks = groupParagraphs(lines);
        } catch (err) {
          console.warn("Não foi possível achar os parágrafos", err);
          blocks = lines.map((line) => ({ lines: [line], single: true, align: "left", leading: null, left: 0, width: line.width, indent: 0, origin: line.origin, text: line.text || line.str, rect: line.rect, size: line.size, angle: line.angle }));
        }
        // Página que é só uma imagem (escaneada ou foto): não há texto para editar.
        const [x0, y0, x1, y1] = page.view;
        const area = Math.abs((x1 - x0) * (y1 - y0));
        const scanned = !lines.length && images.some(({ rect: r }) => (r[2] - r[0]) * (r[3] - r[1]) > 0.5 * area);
        return { lines, blocks, images, scanned };
      })();
      tab.pageCache.set(key, promise);
      promise.then((data) => tab.pageCache.set(`${key}-ready`, data)).catch(() => tab.pageCache.delete(key));
    }
    return tab.pageCache.get(key);
  }

  hitTest(data, [px, py]) {
    const inside = ([x0, y0, x1, y1], pad = 0) => px >= x0 - pad && px <= x1 + pad && py >= y0 - pad && py <= y1 + pad;
    // Um clique numa linha pega o parágrafo inteiro; entre blocos sobrepostos, o menor (o mais específico).
    const area = ([x0, y0, x1, y1]) => (x1 - x0) * (y1 - y0);
    const block = data.blocks.filter((b) => inside(b.rect, Math.max(1.5, 0.15 * b.size))).sort((a, b) => area(a.rect) - area(b.rect))[0];
    if (block) return { kind: "text", block };
    for (let i = data.images.length - 1; i >= 0; i--) {
      if (inside(data.images[i].rect)) return { kind: "image", image: data.images[i] };
    }
    return null;
  }

  updateHover(e) {
    // O quadro pode chegar depois do clique que abriu a edição.
    if (this.editing || this.tool !== "edit") return this.removeHover();
    const hit = this.pageHit(e);
    if (!hit) return this.removeHover();
    const data = hit.tab.pageCache.get(`edit-${hit.pageNumber}-ready`);
    if (!data) {
      this.pageData(hit.tab, hit.pageNumber);
      return this.removeHover();
    }
    const target = this.hitTest(data, hit.pdf);
    if (!target) return this.removeHover();
    const rect = this.cssRect(hit.pageView, target.kind === "text" ? target.block.rect : target.image.rect);
    const layer = this.overlayFor(hit);
    let box = layer.querySelector(".edit-hover");
    if (!box) {
      this.removeHover();
      box = el("div", { class: "edit-hover" });
      layer.append(box);
    }
    Object.assign(box.style, { left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px` });
  }

  removeHover() {
    $$(".edit-hover").forEach((n) => n.remove());
  }

  async editAt(hit) {
    if (this.editing) {
      await this.finishEdit();
      return;
    }
    const data = await this.pageData(hit.tab, hit.pageNumber);
    // Enquanto lia a página, outra edição pode ter começado (ou a ferramenta mudou).
    if (this.editing || this.tool !== "edit") return;
    const target = this.hitTest(data, hit.pdf);
    this.removeHover();
    if (!target) return this.explainNothingHere(data);
    if (target.kind === "text") this.startTextEdit(hit, target.block);
    else this.startImageEdit(hit, target.image);
  }

  /** Clique fora de texto e de imagem: explica por que não há o que editar ali. */
  explainNothingHere(data) {
    const now = Date.now();
    if (now - (this.lastExplain || 0) < 4000) return;
    this.lastExplain = now;
    toast(
      data.scanned
        ? "Esta página é uma imagem (documento escaneado ou foto), por isso o texto dela não é editável. Use Converter → Reconhecer texto (OCR) e depois edite."
        : "Não há texto nem imagem para editar aqui. Se o texto foi salvo como desenho, use “Adicionar texto” para escrever por cima.",
      { duration: 7000 },
    );
  }

  /** Amostra as cores de fundo e do texto no canvas da página. */
  sampleColors(hit, cssRect) {
    const fallback = { bg: [1, 1, 1], fg: [0, 0, 0] };
    const canvas = hit.pageDiv.querySelector(".canvasWrapper canvas");
    if (!canvas) return fallback;
    const box = canvas.getBoundingClientRect();
    const sx = canvas.width / box.width;
    const sy = canvas.height / box.height;
    const margin = 3;
    const x0 = Math.max(0, Math.floor((cssRect.left - margin) * sx));
    const y0 = Math.max(0, Math.floor((cssRect.top - margin) * sy));
    const x1 = Math.min(canvas.width, Math.ceil((cssRect.left + cssRect.width + margin) * sx));
    const y1 = Math.min(canvas.height, Math.ceil((cssRect.top + cssRect.height + margin) * sy));
    if (x1 - x0 < 2 || y1 - y0 < 2) return fallback;
    let pixels;
    try {
      pixels = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0);
    } catch {
      return fallback;
    }
    const { data, width, height } = pixels;
    const counts = new Map();
    const at = (x, y) => {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const edge = [];
    for (let x = 0; x < width; x++) edge.push(at(x, 0), at(x, height - 1));
    for (let y = 0; y < height; y++) edge.push(at(0, y), at(width - 1, y));
    for (const [r, g, b] of edge) {
      const key = `${r >> 3},${g >> 3},${b >> 3}`;
      const entry = counts.get(key) || { n: 0, sum: [0, 0, 0] };
      entry.n++;
      entry.sum[0] += r;
      entry.sum[1] += g;
      entry.sum[2] += b;
      counts.set(key, entry);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    const bg = best.sum.map((v) => v / best.n);
    let fg = [0, 0, 0];
    let farthest = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = at(x, y);
        const d = (p[0] - bg[0]) ** 2 + (p[1] - bg[1]) ** 2 + (p[2] - bg[2]) ** 2;
        if (d > farthest) {
          farthest = d;
          fg = p;
        }
      }
    }
    return { bg: bg.map((v) => v / 255), fg: fg.map((v) => v / 255) };
  }

  // ---- Caixa de texto (editar uma linha ou adicionar texto novo) ----

  /** Estilo do texto novo: o último usado (fonte, negrito, itálico, tamanho e cor). */
  newTextStyle() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem("texto-novo")) || {};
    } catch {
      saved = {};
    }
    return {
      font: fontById(saved.font).id,
      bold: saved.bold === true,
      italic: saved.italic === true,
      size: saved.size >= 4 && saved.size <= 300 ? saved.size : 14,
      color: Array.isArray(saved.color) && saved.color.length === 3 ? saved.color : [0, 0, 0],
      spacing: 0,
    };
  }

  saveNewTextStyle({ font, bold, italic, size, color }) {
    try {
      localStorage.setItem("texto-novo", JSON.stringify({ font, bold, italic, size, color }));
    } catch {
      // Sem armazenamento: o próximo texto volta ao padrão.
    }
  }

  async addTextAt(hit) {
    if (this.editing) {
      await this.finishEdit();
      return;
    }
    this.openTextBox(hit, { mode: "add", text: "", state: this.newTextStyle(), anchor: [hit.x, hit.y] });
  }

  /** Edita o bloco clicado: o parágrafo inteiro ou uma linha sozinha. */
  startTextEdit(hit, block) {
    const line = block.lines[0];
    const css = this.cssRect(hit.pageView, block.rect);
    const { bg, fg } = this.sampleColors(hit, css);
    const match = matchFont(line.realName);
    const substitute = match || fallbackFont(line.style);
    // A própria fonte do PDF (com todas as cópias dela), quando o catálogo não tem a mesma (Arial, Calibri, fontes do Canva...).
    const faces = line.faces?.length ? line.faces : line.face ? [line.face] : [];
    const original = line.original && faces.length ? { label: prettyFontName(line.realName), family: faces.map((face) => `"${face}"`).join(", ") } : null;
    const state = {
      font: original && !match?.exact ? "original" : substitute.id,
      substitute: substitute.id,
      bold: substitute.bold,
      italic: substitute.italic,
      size: Math.round(line.size * 10) / 10,
      color: line.color || fg,
      spacing: line.spacing,
    };
    // Parágrafo: o texto todo, refluindo na largura dele. Linha sozinha: o texto
    // dela (o lido do próprio PDF quando o PDF.js separa as letras, "C L I Q U E").
    const paragraph = block.single ? null : block;
    const text = paragraph ? block.text : line.text || line.str;
    const editing = this.openTextBox(hit, { mode: "edit", line, paragraph, text, state, bg, original });
    editing.originalStyle = { bold: substitute.bold, italic: substitute.italic };
    if (block.lines.some((l) => l.runs)) this.prepareTextPreview(editing);
  }

  /**
   * Caixa de texto editável sobre a página, com a barra de formatação.
   * `mode`: "edit" (troca a linha `line` ou, com `paragraph`, o parágrafo
   * inteiro) ou "add" (texto novo no ponto `anchor`).
   */
  openTextBox(hit, { mode, line = null, paragraph = null, text, state, bg = null, original = null, anchor = null }) {
    const layer = this.overlayFor(hit);
    const editor = el("div", {
      class: paragraph ? "text-editor paragraph" : "text-editor",
      spellcheck: "false",
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": mode === "add" ? "Texto novo" : paragraph ? "Parágrafo" : "Texto",
    });
    try {
      editor.contentEditable = "plaintext-only";
    } catch {
      editor.contentEditable = "true";
    }
    editor.textContent = text;
    if (mode === "add") editor.dataset.placeholder = "Digite o texto";
    // Até a página sem o texto antigo ficar pronta, o fundo cobre o texto antigo.
    if (mode === "edit") editor.style.background = cssColor(bg || [1, 1, 1]);
    const grip = el("span", { class: "text-grip", title: "Arraste para mover", "aria-hidden": "true" });
    // As alças das laterais mudam a largura: o texto quebra nela, como no Canva.
    const sizers = ["left", "right"].map((side) => el("span", { class: "text-sizer", dataset: { side }, title: "Arraste para mudar a largura", "aria-hidden": "true" }));
    const box = el("div", { class: "text-box" }, [grip, editor, ...sizers]);
    const editing = {
      kind: "text",
      mode,
      hit,
      line,
      paragraph,
      width: paragraph?.width ?? null,
      layer,
      box,
      editor,
      state,
      initial: { ...state },
      text0: text,
      bg,
      original,
      anchor,
      offset: [0, 0],
      viewport: hit.pageView.viewport,
    };
    editing.bar = this.textBar(editing);
    layer.append(box, editing.bar);
    this.editing = editing;

    editor.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      // Editando uma linha, Enter conclui (Shift+Enter quebra a linha); no parágrafo e no texto novo, Enter quebra a linha e Ctrl+Enter conclui.
      if (e.key === "Enter" && (mode === "edit" && !paragraph ? !e.shiftKey : mod)) {
        e.preventDefault();
        this.finishEdit();
      } else if (mod && !e.altKey && /^[bi]$/i.test(e.key)) {
        e.preventDefault();
        this.toggleTextStyle(e.key.toLowerCase() === "b" ? "bold" : "italic");
      }
      // Os atalhos com Ctrl (salvar, imprimir) continuam valendo; as outras teclas são do texto.
      if (!mod && e.key !== "Escape") e.stopPropagation();
    });
    editor.addEventListener("input", () => {
      this.placeSizers();
      this.placeTextBar();
    });
    editor.addEventListener("paste", (e) => {
      e.preventDefault();
      const pasted = e.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, pasted.replace(/\r\n?/g, "\n"));
    });
    grip.addEventListener("pointerdown", (e) => this.startTextDrag(e));
    for (const sizer of sizers) sizer.addEventListener("pointerdown", (e) => this.startTextResize(e, sizer.dataset.side));

    this.styleTextEditor();
    this.revealTextBox();
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (mode === "add") range.collapse(false);
    else if (paragraph) {
      // No parágrafo, o cursor fica onde a pessoa clicou (uma tecla não apaga o texto todo).
      const caret = caretAt(hit, editor);
      if (caret) range.setStart(caret.node, caret.offset);
      range.collapse(Boolean(caret));
    }
    selection.removeAllRanges();
    selection.addRange(range);
    return editing;
  }

  /** Barra de formatação: fonte, tamanho, negrito, itálico, cor, apagar e concluir. */
  textBar(editing) {
    const { state, mode } = editing;
    // Clicar nos botões não tira o cursor do texto.
    const keepFocus = (node) => {
      node.addEventListener("mousedown", (e) => e.preventDefault());
      return node;
    };
    const fontButton = keepFocus(
      el("button", { class: "btn font-button", type: "button", title: "Fonte", "aria-haspopup": "dialog", onclick: () => this.pickFont() }, [
        el("span", { class: "font-name" }),
        el("span", { class: "font-caret", html: icon("caret") }),
      ]),
    );
    const size = el("input", { class: "size-input", type: "number", min: "4", max: "300", step: "0.5", title: "Tamanho da letra (pt)", "aria-label": "Tamanho da letra" });
    size.addEventListener("input", () => {
      const value = Number(size.value);
      if (value >= 4 && value <= 300) {
        state.size = value;
        this.styleTextEditor();
      }
    });
    size.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        editing.editor.focus();
      }
    });
    const bold = keepFocus(el("button", { class: "btn toggle", type: "button", title: "Negrito (Ctrl+B)", html: "<b>N</b>", onclick: () => this.toggleTextStyle("bold") }));
    const italic = keepFocus(el("button", { class: "btn toggle", type: "button", title: "Itálico (Ctrl+I)", html: "<i>I</i>", onclick: () => this.toggleTextStyle("italic") }));
    const color = el("input", { class: "color-input", type: "color", title: "Cor do texto", "aria-label": "Cor do texto" });
    color.addEventListener("input", () => {
      state.color = hexToRgb(color.value);
      this.styleTextEditor();
    });
    const remove = keepFocus(
      el("button", {
        class: "btn icon-only",
        type: "button",
        title: mode === "add" ? "Descartar este texto" : "Apagar este texto do PDF",
        html: icon("trash"),
        onclick: () => this.deleteText(),
      }),
    );
    const done = keepFocus(
      el("button", { class: "btn primary", type: "button", text: "Concluir", title: mode === "add" || editing.paragraph ? "Concluir (Ctrl+Enter)" : "Concluir (Enter)", onclick: () => this.finishEdit() }),
    );
    editing.controls = { fontButton, size, bold, italic, color };
    return el("div", { class: "float-bar text-bar" }, [fontButton, size, bold, italic, color, remove, done]);
  }

  updateTextBar() {
    const { state, controls, original } = this.editing;
    const name = state.font === "original" ? original.label : fontById(state.font).family;
    controls.fontButton.querySelector(".font-name").textContent = name;
    controls.fontButton.title = state.font === "original" ? `Fonte: ${name} (a original do PDF)` : `Fonte: ${name}`;
    if (document.activeElement !== controls.size) controls.size.value = String(Math.round(state.size * 10) / 10);
    controls.bold.setAttribute("aria-pressed", String(Boolean(state.bold)));
    controls.italic.setAttribute("aria-pressed", String(Boolean(state.italic)));
    controls.color.value = rgbToHex(state.color);
  }

  /** Aplica o estilo na caixa (fonte, tamanho, cor...) e a posiciona quando a fonte carrega. */
  async styleTextEditor() {
    const editing = this.editing;
    if (editing?.kind !== "text") return;
    const { editor, state, viewport } = editing;
    const original = state.font === "original";
    const catalogId = original ? state.substitute : state.font;
    // Com a fonte original, as letras que ela não tem saem com a substituta (no estilo certo).
    const family = original ? `${editing.original.family}, ${exactFamily(catalogId, state.bold)}` : cssFamily(catalogId);
    const paragraph = editing.paragraph;
    Object.assign(editor.style, {
      fontFamily: `${family}, sans-serif`,
      fontSize: `${state.size * viewport.scale}px`,
      // No parágrafo, a mesma distância entre as linhas do PDF.
      lineHeight: String(paragraph ? paragraph.leading / paragraph.size : LINE_HEIGHT),
      textAlign: paragraph ? paragraph.align : "",
      textIndent: paragraph?.indent ? `${paragraph.indent * viewport.scale}px` : "",
      fontWeight: !original && state.bold ? "700" : "400",
      fontStyle: !original && state.italic ? "italic" : "normal",
      color: cssColor(state.color),
      letterSpacing: `${(state.spacing || 0) * viewport.scale}px`,
    });
    this.applyTextWidth();
    this.updateTextBar();
    this.placeTextEditor();
    const token = {};
    editing.styleToken = token;
    try {
      await (original ? loadFontFace(catalogId, state.bold, { exact: true }) : loadFontFace(catalogId, state.bold));
    } catch {
      // Sem a fonte (sem internet na primeira vez, por exemplo), a prévia usa outra.
    }
    if (this.editing !== editing || editing.styleToken !== token) return;
    if (state.spacing === null) {
      // Linha com espaçamento entre letras que não deu para medir no PDF: estima pela largura.
      state.spacing = editing.line?.letterSpaced ? estimateSpacing(editor, editing.line, viewport.scale) : 0;
      editing.initial.spacing = state.spacing;
      editor.style.letterSpacing = `${state.spacing * viewport.scale}px`;
    }
    this.placeTextEditor();
  }

  /** Põe a caixa com a linha de base no lugar do texto (ou no ponto clicado, no texto novo). */
  placeTextEditor() {
    const editing = this.editing;
    if (editing?.kind !== "text") return;
    const { box, editor, viewport, state } = editing;
    const baseline = baselineOffset(editor);
    let x;
    let y;
    let theta = 0;
    if (editing.mode === "add") {
      // O clique fica no meio da primeira linha.
      x = editing.anchor[0];
      y = editing.anchor[1] - (state.size * viewport.scale * LINE_HEIGHT) / 2 + baseline;
    } else {
      const { angle } = editing.line;
      const origin = editing.paragraph ? editing.paragraph.origin : editing.line.origin;
      [x, y] = viewport.convertToViewportPoint(...origin);
      const [dx, dy] = viewport.convertToViewportPoint(origin[0] + Math.cos(angle), origin[1] + Math.sin(angle));
      theta = Math.atan2(dy - y, dx - x);
    }
    x += editing.offset[0];
    y += editing.offset[1];
    Object.assign(box.style, {
      left: `${x}px`,
      top: `${y - baseline}px`,
      transformOrigin: `0 ${baseline}px`,
      transform: Math.abs(theta) > 1e-3 ? `rotate(${theta}rad)` : "",
    });
    editing.baselinePoint = [x, y];
    editing.theta = theta;
    this.placeSizers();
    this.placeTextBar();
  }

  /** Com a largura definida, o texto quebra na caixa (1 px de folga para arredondamentos). */
  applyTextWidth() {
    const { editor, width, viewport } = this.editing;
    editor.classList.toggle("wrap", width !== null);
    editor.style.width = width === null ? "" : `${width * viewport.scale + 1}px`;
  }

  /**
   * Na linha que passa da borda da página, a alça da direita fica na borda,
   * ao alcance: no fim do texto ela ficaria fora da página (às vezes da tela).
   */
  placeSizers() {
    const editing = this.editing;
    const { box, editor, layer, width, baselinePoint, theta, viewport, state } = editing;
    const room = Math.max(2 * state.size * viewport.scale, edgeDistance(baselinePoint, theta, layer.clientWidth, layer.clientHeight) - 24);
    editing.reach = width === null && editor.offsetWidth > room ? room : null;
    const right = box.querySelector('.text-sizer[data-side="right"]');
    right.style.left = editing.reach === null ? "" : `${editing.reach + 6}px`;
    right.style.right = editing.reach === null ? "" : "auto";
  }

  /** Barra acima da caixa (abaixo, se não couber), sem passar da borda da página. */
  placeTextBar() {
    const editing = this.editing;
    if (editing?.kind !== "text") return;
    const { box, bar, layer } = editing;
    bar.style.maxWidth = `${Math.max(220, layer.clientWidth)}px`;
    const r = handlesRect(box);
    const l = layer.getBoundingClientRect();
    const left = Math.max(0, Math.min(r.left - l.left, layer.clientWidth - bar.offsetWidth));
    const above = r.top - l.top - bar.offsetHeight - 8;
    Object.assign(bar.style, { left: `${left}px`, top: `${above >= 0 ? above : r.bottom - l.top + 8}px` });
  }

  /** Rola a página para a caixa e a barra aparecerem inteiras (perto da borda, por exemplo). */
  revealTextBox() {
    const { box, bar, hit } = this.editing;
    const container = hit.tab.container;
    const view = container.getBoundingClientRect();
    const rects = [handlesRect(box), bar.getBoundingClientRect()];
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    if (top < view.top + 8) container.scrollTop -= view.top + 8 - top;
    else if (bottom > view.bottom - 8 && bottom - top < view.height) container.scrollTop += bottom - (view.bottom - 8);
  }

  /** Arrastar pela alça move o texto. */
  startTextDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    const editing = this.editing;
    const start = [e.clientX, e.clientY];
    const from = [...editing.offset];
    const move = (ev) => {
      if (this.editing !== editing) return;
      editing.offset = [from[0] + ev.clientX - start[0], from[1] + ev.clientY - start[1]];
      this.placeTextEditor();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (this.editing === editing) editing.editor.focus({ preventScroll: true });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /**
   * Arrastar a alça de uma lateral muda a largura da caixa (na direção do
   * texto) e o texto quebra nela. A da esquerda leva junto o começo do texto.
   */
  startTextResize(e, side) {
    e.preventDefault();
    e.stopPropagation();
    const editing = this.editing;
    const { viewport, editor, theta } = editing;
    const start = [e.clientX, e.clientY];
    // Sem largura definida (uma linha, texto novo), parte da largura da caixa, até a borda da página.
    const from = editing.width ?? (editing.reach ?? editor.offsetWidth) / viewport.scale;
    const offset = [...editing.offset];
    const min = 2 * editing.state.size;
    const move = (ev) => {
      if (this.editing !== editing) return;
      const along = ((ev.clientX - start[0]) * Math.cos(theta) + (ev.clientY - start[1]) * Math.sin(theta)) / viewport.scale;
      editing.width = Math.max(min, side === "right" ? from + along : from - along);
      if (side === "left") {
        // A borda da direita fica onde está.
        const shift = (from - editing.width) * viewport.scale;
        editing.offset = [offset[0] + shift * Math.cos(theta), offset[1] + shift * Math.sin(theta)];
      }
      this.applyTextWidth();
      this.placeTextEditor();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (this.editing === editing) editing.editor.focus({ preventScroll: true });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  toggleTextStyle(kind) {
    const editing = this.editing;
    if (editing?.kind !== "text") return;
    // A fonte do PDF é como é: negrito ou itálico passam para a fonte do catálogo.
    if (editing.state.font === "original") editing.state.font = editing.state.substitute;
    editing.state[kind] = !editing.state[kind];
    this.styleTextEditor();
  }

  pickFont() {
    const editing = this.editing;
    if (editing?.kind !== "text") return;
    if (fontPickerOpen()) return closeFontPicker();
    const selection = window.getSelection();
    const range = selection.rangeCount && editing.editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    openFontPicker({
      anchor: editing.controls.fontButton,
      current: editing.state.font,
      original: editing.original,
      onPick: (id) => {
        if (this.editing !== editing) return;
        editing.state.font = id;
        if (id === "original") Object.assign(editing.state, editing.originalStyle);
        this.styleTextEditor();
      },
      onClose: () => {
        if (this.editing !== editing) return;
        editing.editor.focus({ preventScroll: true });
        if (range) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      },
    });
  }

  deleteText() {
    const editing = this.editing;
    if (editing?.kind !== "text") return null;
    if (editing.mode === "add") return this.clearEdit();
    editing.editor.textContent = "";
    return this.finishEdit();
  }

  /** Mostra a página sem o texto antigo por baixo da caixa (prévia exata). */
  async prepareTextPreview(editing) {
    const pageCanvas = editing.hit.pageDiv.querySelector(".canvasWrapper canvas");
    if (!pageCanvas) return;
    const lines = editing.paragraph ? editing.paragraph.lines : [editing.line];
    let complete = false;
    try {
      const clean = await this.renderPageCopy(editing, pageCanvas, (doc, page) => {
        const all = findTextRuns(doc, page);
        const found = lines.map((line) => lineRuns(all, line));
        const runs = found.flatMap((r) => r || []);
        if (!runs.length) return false;
        removeRuns(doc, page, runs);
        complete = found.every(Boolean);
        return true;
      });
      if (!clean || this.editing !== editing) return;
      editing.layer.prepend(clean);
      editing.clean = clean;
      // Linha que não saiu do conteúdo continua coberta pelo fundo da caixa (como vai ficar no PDF).
      if (complete) editing.editor.style.background = "transparent";
    } catch (err) {
      console.warn("Sem prévia do texto:", err);
    }
  }

  async commitText() {
    const editing = this.editing;
    const { hit, mode, line, paragraph, state, bg, viewport } = editing;
    const text = editorText(editing.editor);
    // Com a largura definida, as linhas como aparecem na caixa (antes de ela sair da tela).
    const rows = editing.width !== null ? visualRows(editing.editor, paragraph?.align === "justify") : null;
    const [bx, by] = editing.baselinePoint;
    const origin = viewport.convertToPdfPoint(bx, by);
    this.clearEdit();
    const fontId = state.font === "original" ? state.substitute : state.font;
    if (mode === "add") {
      if (!text.trim()) return;
      // Na direção do texto na tela (de pé, mesmo com a página girada).
      const ahead = viewport.convertToPdfPoint(bx + 10, by);
      const angle = Math.atan2(ahead[1] - origin[1], ahead[0] - origin[0]);
      this.saveNewTextStyle(state);
      rememberFont(fontId);
      await this.run("Adicionando texto…", async () => {
        const catalog = await catalogFont(fontId, state.bold);
        await hit.tab.edit((doc) => addText(doc, hit.pageIndex, { origin, angle, text, rows, style: state, catalog }));
      });
      return;
    }
    const moved = Math.hypot(...editing.offset) > 0.5;
    const initial = editing.initial;
    const restyled =
      ["font", "bold", "italic", "size", "spacing"].some((k) => state[k] !== initial[k]) || state.color.some((v, i) => Math.abs(v - initial.color[i]) > 0.002);
    // Na linha sozinha, a largura só muda algo se o texto quebrou na caixa.
    const resized = paragraph ? Math.abs(editing.width - paragraph.width) > 0.5 : rows !== null && rows.length > text.split("\n").length;
    if (text === editing.text0 && !moved && !restyled && !resized) return;
    if (state.font !== "original") rememberFont(fontId);
    await this.run(text.trim() ? "Aplicando texto…" : "Apagando texto…", async () => {
      const catalog = await catalogFont(fontId, state.bold);
      const style = { ...state, spacing: state.spacing || 0 };
      if (paragraph) {
        const start = moved ? origin : paragraph.origin;
        await hit.tab.edit((doc) => editBlock(doc, hit.pageIndex, { block: paragraph, rows, style, catalog, bg, origin: start, width: editing.width }));
      } else {
        await hit.tab.edit((doc) => editText(doc, hit.pageIndex, { line, text, rows, style, catalog, bg, origin: moved ? origin : line.origin }));
      }
    });
  }

  /**
   * Caixa com alças para mover e redimensionar, com a prévia dentro: a imagem
   * em edição ou a assinatura sendo posicionada.
   */
  openBox(hit, kind, rect, { handles = ALL_HANDLES, preview, buttons, extra }) {
    const layer = this.overlayFor(hit);
    const box = el("div", { class: "image-box" }, [preview]);
    for (const h of handles) box.append(el("span", { class: "handle", dataset: { h } }));
    const bar = el("div", { class: "float-bar" }, buttons);
    layer.append(box, bar);
    this.editing = { kind, hit, layer, box, bar, preview, viewport: hit.pageView.viewport, rect: { ...rect }, original: { ...rect }, aspect: rect.width / rect.height, ...extra };
    this.layoutImageBox();
    box.addEventListener("pointerdown", (e) => this.startImageDrag(e));
    return this.editing;
  }

  startImageEdit(hit, image) {
    const css = this.cssRect(hit.pageView, image.rect);
    const pageCanvas = hit.pageDiv.querySelector(".canvasWrapper canvas");
    // Até a prévia exata ficar pronta, mostra o recorte do que está na tela.
    const preview = pageCanvas ? cropCanvas(pageCanvas, css) : el("span");
    preview.classList.add("box-preview");
    const editing = this.openBox(hit, "image", css, {
      preview,
      buttons: [
        el("button", { class: "btn", type: "button", html: `${icon("image")}<span>Substituir</span>`, onclick: () => this.replaceImage() }),
        el("button", { class: "btn", type: "button", html: `${icon("trash")}<span>Excluir</span>`, onclick: () => this.deleteImage() }),
        el("button", { class: "btn primary", type: "button", text: "Concluir", onclick: () => this.finishEdit() }),
      ],
      extra: { image },
    });
    if (pageCanvas) this.prepareImagePreview(editing, pageCanvas);
  }

  /**
   * Prévia exata da edição de imagem: redesenha a página sem a imagem (por
   * cima da página na tela) e põe dentro da caixa a imagem como ela aparece,
   * com transparência quando ela tem.
   */
  async prepareImagePreview(editing, pageCanvas) {
    const { hit, image } = editing;
    try {
      const clean = await this.renderPageCopy(editing, pageCanvas, (doc, page) => removeImage(doc, page, image.index));
      if (!clean || this.editing !== editing) return;
      const lib = await this.libDoc(hit.tab);
      if (imageHasMask(lib, lib.getPage(hit.pageIndex), image.name)) {
        const matte = transparentCrop(pageCanvas, clean, editing.original);
        matte.classList.add("box-preview");
        editing.preview.replaceWith(matte);
        editing.preview = matte;
      }
      editing.layer.prepend(clean);
      editing.clean = clean;
    } catch (err) {
      console.warn("Sem prévia da imagem:", err);
    }
  }

  /**
   * Desenha a página alterada por `change(doc, page)` (numa cópia) num canvas
   * do tamanho do da tela. null se `change` devolver false (nada a mostrar).
   */
  async renderPageCopy(editing, pageCanvas, change) {
    const { hit, viewport } = editing;
    let pdf = null;
    try {
      const lib = await this.libDoc(hit.tab);
      const copy = await PDFDocument.create();
      const [page] = await copy.copyPages(lib, [hit.pageIndex]);
      copy.addPage(page);
      if (change(copy, copy.getPage(0)) === false) return null;
      ({ doc: pdf } = await loadPdf(await copy.save()));
      const pdfPage = await pdf.getPage(1);
      const vp = pdfPage.getViewport({ scale: viewport.scale, rotation: viewport.rotation });
      const clean = el("canvas", { class: "clean-page" });
      clean.width = pageCanvas.width;
      clean.height = pageCanvas.height;
      await pdfPage.render({
        canvasContext: clean.getContext("2d"),
        viewport: vp,
        transform: [clean.width / vp.width, 0, 0, clean.height / vp.height, 0, 0],
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
      }).promise;
      return clean;
    } finally {
      pdf?.destroy();
    }
  }

  layoutImageBox() {
    const { box, bar, rect, layer } = this.editing;
    Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    // Barra acima da caixa (abaixo quando não cabe) e sem passar da borda da página.
    const left = Math.max(0, Math.min(rect.left, layer.clientWidth - bar.offsetWidth));
    const top = rect.top >= 40 ? rect.top - 40 : rect.top + rect.height + 8;
    Object.assign(bar.style, { left: `${left}px`, top: `${top}px` });
  }

  /**
   * O zoom recria as camadas da página: a assinatura em posicionamento volta
   * no mesmo lugar da página, na escala nova; as outras edições são concluídas.
   */
  followZoom() {
    const editing = this.editing;
    if (!editing) return;
    const viewport = editing.hit.pageView.viewport;
    // Mesmo zoom (ex.: "Automático" reaplicado): as camadas não mudaram.
    if (viewport.scale === (editing.viewport?.scale ?? editing.hit.scale)) return;
    if (editing.kind === "text") {
      // O texto continua em edição, no mesmo lugar da página e na escala nova.
      const ratio = viewport.scale / editing.viewport.scale;
      if (editing.anchor) editing.anchor = editing.anchor.map((v) => v * ratio);
      editing.offset = editing.offset.map((v) => v * ratio);
      editing.viewport = viewport;
      editing.layer = this.overlayFor(editing.hit);
      editing.layer.append(...[editing.clean, editing.box, editing.bar].filter(Boolean));
      this.styleTextEditor();
      editing.editor.focus({ preventScroll: true });
      return;
    }
    if (editing.kind !== "signature") return this.finishEdit();
    const { viewport: old, rect } = editing;
    const a = viewport.convertToViewportPoint(...old.convertToPdfPoint(rect.left, rect.top));
    const b = viewport.convertToViewportPoint(...old.convertToPdfPoint(rect.left + rect.width, rect.top + rect.height));
    editing.viewport = viewport;
    editing.layer = this.overlayFor(editing.hit);
    editing.layer.append(editing.box, editing.bar);
    editing.rect = { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
    this.layoutImageBox();
  }

  clampToLayer(layer, r) {
    const width = layer.clientWidth || r.width;
    const height = layer.clientHeight || r.height;
    return { ...r, left: Math.min(Math.max(0, r.left), Math.max(0, width - r.width)), top: Math.min(Math.max(0, r.top), Math.max(0, height - r.height)) };
  }

  /** Mantém a caixa dentro da página. */
  clampToPage(r) {
    return this.clampToLayer(this.editing.layer, r);
  }

  startImageDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    const editing = this.editing;
    const handle = e.target.dataset.h || null;
    const startRect = { ...editing.rect };
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      let r = { ...startRect };
      if (!handle) {
        r.left += dx;
        r.top += dy;
        r = this.clampToPage(r);
      } else {
        if (handle.includes("e")) r.width = Math.max(8, startRect.width + dx);
        if (handle.includes("s")) r.height = Math.max(8, startRect.height + dy);
        if (handle.includes("w")) {
          r.width = Math.max(8, startRect.width - dx);
          r.left = startRect.left + startRect.width - r.width;
        }
        if (handle.includes("n")) {
          r.height = Math.max(8, startRect.height - dy);
          r.top = startRect.top + startRect.height - r.height;
        }
        // Cantos mantêm a proporção (Shift libera).
        if (handle.length === 2 && !ev.shiftKey) {
          r.height = r.width / editing.aspect;
          if (handle.includes("n")) r.top = startRect.top + startRect.height - r.height;
        }
      }
      editing.rect = r;
      this.layoutImageBox();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  imagePdfRect() {
    const { rect, viewport: vp } = this.editing;
    const a = vp.convertToPdfPoint(rect.left, rect.top + rect.height);
    const b = vp.convertToPdfPoint(rect.left + rect.width, rect.top);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }

  async commitImage() {
    const { hit, image, rect, original } = this.editing;
    const changed = ["left", "top", "width", "height"].some((k) => Math.abs(rect[k] - original[k]) > 0.5);
    const target = this.imagePdfRect();
    this.clearEdit();
    if (!changed) return;
    await this.run("Movendo imagem…", () => hit.tab.edit((doc) => moveImage(doc, doc.getPage(hit.pageIndex), image.index, target)));
  }

  deleteImage() {
    const { hit, image } = this.editing;
    this.clearEdit();
    return this.track(this.run("Excluindo imagem…", () => hit.tab.edit((doc) => removeImage(doc, doc.getPage(hit.pageIndex), image.index))));
  }

  async replaceImage() {
    const { hit, image } = this.editing;
    const target = this.imagePdfRect();
    const [file] = await platform.pickFiles({ kind: "images" });
    if (!file) return;
    this.clearEdit();
    await this.run("Substituindo imagem…", () =>
      hit.tab.edit(async (doc) => {
        const page = doc.getPage(hit.pageIndex);
        removeImage(doc, page, image.index);
        isolatePage(doc, page);
        const embedded = /\.png$/i.test(file.name) ? await doc.embedPng(file.data) : await doc.embedJpg(file.data);
        const [x0, y0, x1, y1] = target;
        const scale = Math.min((x1 - x0) / embedded.width, (y1 - y0) / embedded.height);
        const w = embedded.width * scale;
        const h = embedded.height * scale;
        page.drawImage(embedded, { x: x0 + (x1 - x0 - w) / 2, y: y0 + (y1 - y0 - h) / 2, width: w, height: h });
      }),
    );
  }

  /** Conclui a edição aberta, como ao clicar fora dela: aplica o que mudou. */
  finishEdit() {
    const kind = this.editing?.kind;
    if (kind === "signature") return this.commitSignature();
    if (kind === "text") return this.track(this.commitText());
    if (kind === "image") return this.track(this.commitImage());
    return this.committing;
  }

  /** Guarda a alteração em andamento para quem precisa esperar por ela. */
  track(promise) {
    const tracked = promise.finally(() => {
      if (this.committing === tracked) this.committing = null;
    });
    this.committing = tracked;
    return tracked;
  }

  /** Conclui a edição aberta e espera aplicar (antes de salvar, por exemplo). */
  async settled() {
    this.finishEdit();
    await this.committing;
    // Aplicar recarrega o documento: espera a página atual e o zoom voltarem,
    // senão a próxima ação (girar a página atual, por exemplo) erra a página.
    await this.tab?.loaded;
  }

  clearEdit() {
    if (!this.editing) return;
    const { box, bar, clean } = this.editing;
    this.editing = null;
    closeFontPicker();
    box?.remove();
    bar?.remove();
    clean?.remove();
  }
}

const cssColor = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(", ")})`;

/** "ABCDEF+MontserratThin-Bold" -> "Montserrat Thin Bold". */
function prettyFontName(name) {
  return (
    name
      .replace(/^[A-Z]{6}\+/, "")
      .replace(/-\d+$/, "")
      .replace(/[-_,]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim() || "Fonte do documento"
  );
}

/** Distância do topo da caixa até a linha de base da primeira linha, com a fonte atual. */
function baselineOffset(editor) {
  const style = getComputedStyle(editor);
  const mark = el("span");
  const probe = el("div", { class: "baseline-probe" }, [mark]);
  Object.assign(probe.style, {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
  });
  document.body.append(probe);
  const offset = mark.offsetTop;
  probe.remove();
  return offset;
}

/** Espaçamento entre letras (pt) que faz o texto ocupar a largura da linha original. */
function estimateSpacing(editor, line, scale) {
  const text = editorText(editor);
  const count = [...text].length;
  if (count < 2) return 0;
  const style = getComputedStyle(editor);
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${style.fontStyle} ${style.fontWeight} 100px ${style.fontFamily}`;
  const natural = (ctx.measureText(text).width / 100) * line.size;
  return Math.max(0, (line.width - natural) / (count - 1));
}

/** O retângulo na tela da caixa de texto com as alças (que ficam por fora dela). */
function handlesRect(box) {
  const rects = [box, ...box.querySelectorAll(".text-grip, .text-sizer")].map((node) => node.getBoundingClientRect());
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

/** Distância de `point` até a borda do retângulo de `width` × `height`, andando no ângulo `theta`. */
function edgeDistance([x, y], theta, width, height) {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let distance = Infinity;
  if (cos > 1e-6) distance = Math.min(distance, (width - x) / cos);
  if (cos < -1e-6) distance = Math.min(distance, -x / cos);
  if (sin > 1e-6) distance = Math.min(distance, (height - y) / sin);
  if (sin < -1e-6) distance = Math.min(distance, -y / sin);
  return distance;
}

/** O lugar do texto da caixa que está sob o clique `hit`, ou null. */
function caretAt(hit, editor) {
  const box = hit.wrapper.getBoundingClientRect();
  const x = box.left + hit.x;
  const y = box.top + hit.y;
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    node = position?.offsetNode ?? null;
    offset = position?.offset ?? 0;
  } else if (document.caretRangeFromPoint) {
    const found = document.caretRangeFromPoint(x, y);
    node = found?.startContainer ?? null;
    offset = found?.startOffset ?? 0;
  }
  return node && editor.contains(node) ? { node, offset } : null;
}

/** O texto da caixa, com as quebras de linha. */
function editorText(editor) {
  return editor.innerText.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

/**
 * As linhas do texto como aparecem na caixa: onde o navegador quebrou a linha
 * (o texto continua) e onde há quebra de verdade (Enter). Com `justify`, as
 * linhas que continuam na de baixo são justificadas. Assim o PDF fica igual à
 * caixa, sem depender de as medidas das letras baterem com as do navegador.
 */
function visualRows(editor, justify) {
  // Mede com a caixa de pé (no texto girado ela está girada), com as linhas na horizontal.
  const box = editor.parentElement;
  const transform = box.style.transform;
  box.style.transform = "";
  try {
    return rowsOnScreen(editor, justify);
  } finally {
    box.style.transform = transform;
  }
}

function rowsOnScreen(editor, justify) {
  const rows = [];
  let row = { text: "", top: null };
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 10;
  const breakRow = (hard) => {
    rows.push({ text: hard ? row.text : row.text.replace(/ +$/, ""), hard });
    row = { text: "", top: null };
  };
  const range = document.createRange();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // <br> é quebra de linha; um <div> (Enter em alguns navegadores) começa outra.
      if (node.nodeName === "BR") breakRow(true);
      else if (node.nodeName === "DIV" && (row.text || rows.length)) breakRow(true);
      continue;
    }
    const value = node.nodeValue;
    for (let i = 0; i < value.length; i++) {
      const char = value[i] === "\u00a0" ? " " : value[i];
      if (char === "\n") {
        breakRow(true);
        continue;
      }
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rects = range.getClientRects();
      const rect = rects[rects.length - 1];
      // A letra desceu para a linha de baixo: o navegador quebrou a linha aqui.
      if (rect && rect.width + rect.height > 0 && char !== " ") {
        if (row.top !== null && rect.top > row.top + lineHeight / 2) breakRow(false);
        if (row.top === null) row.top = rect.top;
      }
      row.text += char;
    }
  }
  breakRow(true);
  // Linhas vazias no fim (o <br> que o navegador deixa depois de um Enter) não mudam nada no PDF.
  while (rows.length > 1 && !rows[rows.length - 1].text) rows.pop();
  return rows.map(({ text, hard }) => ({ text, justify: justify && !hard }));
}

/** Pixels de `canvas` dentro do retângulo CSS `css` (relativo à página). */
function pixelRect(canvas, css) {
  const box = canvas.getBoundingClientRect();
  const sx = canvas.width / (box.width || canvas.width);
  const sy = canvas.height / (box.height || canvas.height);
  const x = Math.max(0, Math.floor(css.left * sx));
  const y = Math.max(0, Math.floor(css.top * sy));
  return {
    x,
    y,
    w: Math.max(1, Math.min(canvas.width - x, Math.ceil(css.width * sx))),
    h: Math.max(1, Math.min(canvas.height - y, Math.ceil(css.height * sy))),
  };
}

/** Recorte do canvas da página (o que aparece na tela). */
/** Clique numa barra de rolagem (não é um clique na página). */
function onScrollbar(e) {
  const t = e.target;
  return t instanceof HTMLElement && t.clientWidth > 0 && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight);
}

function cropCanvas(canvas, css) {
  const r = pixelRect(canvas, css);
  const out = document.createElement("canvas");
  out.width = r.w;
  out.height = r.h;
  out.getContext("2d").drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return out;
}

/**
 * Recorte com transparência: compara a página com e sem a imagem; o que não
 * mudou era o fundo aparecendo pela imagem e fica transparente.
 */
function transparentCrop(withImage, without, css) {
  const r = pixelRect(withImage, css);
  const a = withImage.getContext("2d").getImageData(r.x, r.y, r.w, r.h);
  const b = without.getContext("2d").getImageData(r.x, r.y, r.w, r.h).data;
  const d = a.data;
  for (let i = 0; i < d.length; i += 4) {
    const diff = Math.abs(d[i] - b[i]) + Math.abs(d[i + 1] - b[i + 1]) + Math.abs(d[i + 2] - b[i + 2]);
    d[i + 3] = diff < 4 ? 0 : Math.min(255, diff * 6);
  }
  const out = document.createElement("canvas");
  out.width = r.w;
  out.height = r.h;
  out.getContext("2d").putImageData(a, 0, 0);
  return out;
}

/** Junta retângulos da mesma linha (a seleção do navegador gera vários por linha). */
function mergeQuads(quads, rotation) {
  const vertical = rotation % 180 !== 0;
  // Trabalha num espaço em que as linhas são horizontais.
  const toLine = ([x0, y0, x1, y1]) => (vertical ? [y0, x0, y1, x1] : [x0, y0, x1, y1]);
  const items = quads.map(toLine).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const merged = [];
  for (const q of items) {
    const last = merged[merged.length - 1];
    if (last) {
      const overlap = Math.min(last[3], q[3]) - Math.max(last[1], q[1]);
      const minH = Math.min(last[3] - last[1], q[3] - q[1]);
      const gap = q[0] - last[2];
      if (overlap > minH * 0.6 && gap < minH * 0.8 && gap > -minH * 50) {
        last[0] = Math.min(last[0], q[0]);
        last[1] = Math.min(last[1], q[1]);
        last[2] = Math.max(last[2], q[2]);
        last[3] = Math.max(last[3], q[3]);
        continue;
      }
    }
    merged.push([...q]);
  }
  return merged.map(toLine);
}
