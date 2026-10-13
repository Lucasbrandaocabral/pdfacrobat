// Ferramentas de interação com a página: as do próprio PDF.js (destacar,
// texto, desenho, imagem) e as nossas (sublinhar, tachar, nota, formas,
// carimbo, assinatura, marcas do "Preencher e assinar" e edição de
// texto/imagens).
import { AnnotationEditorParamsType, AnnotationEditorType, fontRealName, getTextItems } from "./pdfjs.js";
import { $, $$, askText, el, hexToRgb, toast } from "./ui.js";
import { icon } from "./icons.js";
import * as annotations from "./pdf/annotations.js";
import { findImages, isolatePage, moveImage, removeImage } from "./pdf/content.js";
import { drawPngOnPage } from "./pdf/ops.js";
import { drawMark, today } from "./pdf/fill.js";
import { fontStyle, replaceText } from "./pdf/textedit.js";
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
    manager.on("scalechange", (tab) => tab.active && this.clearEdit());
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
    this.clearEdit();
    this.apply(tool);
    if (tool === "image") this.setEditorParam(AnnotationEditorParamsType.CREATE, null);
  }

  /** Começa a posicionar a assinatura (ou as iniciais), criada agora ou salva. */
  async startSignature(signature) {
    const tab = this.tab;
    if (!tab?.doc || !(await this.guard(tab, ...PERMISSIONS.sign))) return;
    this.clearEdit();
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
    if (tool !== "sign") this.signature = null;
    this.ghost.hidden = true;
    this.ghost.dataset.kind = "";
    this.cancelDrag();
    if (tool !== "edit") this.clearEdit();
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
    if (e.key === "Escape" && this.pending) {
      e.preventDefault();
      this.resolvePending(null);
      return;
    }
    if (e.key === "Escape") {
      if (this.editing) {
        e.preventDefault();
        this.clearEdit();
      } else if (this.drag) {
        this.cancelDrag();
      }
      return;
    }
    if (this.editing?.kind === "image" && !e.target.closest?.("input, textarea, [contenteditable]")) {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.deleteImage();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.commitImage();
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
    const tool = this.tool;
    if (!["note", "shape", "sign", "stamp", "mark", "edit"].includes(tool)) return;
    if (tool === "edit" && e.target.closest?.(".text-editor, .image-box, .float-bar")) return;
    const hit = this.pageHit(e);
    if (!hit) {
      if (tool === "edit") this.finishEdit();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (tool === "note") this.addNote(hit);
    else if (tool === "shape") this.startShape(e, hit);
    else if (tool === "sign") this.placeSignature(hit);
    else if (tool === "stamp") this.placeStamp(hit);
    else if (tool === "mark") this.placeMark(hit);
    else this.editAt(hit);
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

  async placeSignature(hit) {
    const signature = this.signature;
    if (!signature) return;
    const [w, h] = this.ghostSize(hit.scale);
    // Canto inferior esquerdo da assinatura, como visto na tela.
    const origin = hit.pageView.viewport.convertToPdfPoint(hit.x - w / 2, hit.y + h / 2);
    this.apply("select");
    await this.run("Aplicando assinatura…", () =>
      hit.tab.edit((doc) =>
        drawPngOnPage(doc, {
          pageIndex: hit.pageIndex,
          pngBytes: signature.png,
          origin,
          width: w / hit.scale,
          height: h / hit.scale,
          rotation: hit.rotation,
        }),
      ),
    );
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

  /** Itens de texto e imagens da página (em cache até o próximo recarregamento). */
  pageData(tab, pageNumber) {
    const key = `edit-${pageNumber}`;
    if (!tab.pageCache.has(key)) {
      const promise = (async () => {
        const page = await tab.doc.getPage(pageNumber);
        const items = await getTextItems(page);
        for (const item of items) item.style = fontStyle(item.fontFamily, fontRealName(page, item.fontName));
        if (!tab.pageCache.has("lib")) {
          tab.pageCache.set("lib", tab.doc.getData().then((bytes) => loadForEdit(bytes, tab.encrypted ? tab.security : null)));
        }
        const lib = await tab.pageCache.get("lib");
        let images = [];
        try {
          images = findImages(lib, lib.getPage(pageNumber - 1));
        } catch (err) {
          console.warn("Não foi possível ler as imagens da página", err);
        }
        return { items, images };
      })();
      tab.pageCache.set(key, promise);
      promise.then((data) => tab.pageCache.set(`${key}-ready`, data)).catch(() => tab.pageCache.delete(key));
    }
    return tab.pageCache.get(key);
  }

  hitTest(data, [px, py]) {
    const inside = ([x0, y0, x1, y1], pad = 0) => px >= x0 - pad && px <= x1 + pad && py >= y0 - pad && py <= y1 + pad;
    const item = data.items.find((it) => inside(it.rect, 1));
    if (item) return { kind: "text", item };
    for (let i = data.images.length - 1; i >= 0; i--) {
      if (inside(data.images[i].rect)) return { kind: "image", image: data.images[i] };
    }
    return null;
  }

  updateHover(e) {
    const hit = this.pageHit(e);
    if (!hit) return this.removeHover();
    const data = hit.tab.pageCache.get(`edit-${hit.pageNumber}-ready`);
    if (!data) {
      this.pageData(hit.tab, hit.pageNumber);
      return this.removeHover();
    }
    const target = this.hitTest(data, hit.pdf);
    if (!target) return this.removeHover();
    const rect = this.cssRect(hit.pageView, target.kind === "text" ? target.item.rect : target.image.rect);
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
    const target = this.hitTest(data, hit.pdf);
    this.removeHover();
    if (!target) return;
    if (target.kind === "text") this.startTextEdit(hit, target.item);
    else this.startImageEdit(hit, target.image);
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

  startTextEdit(hit, item) {
    const css = this.cssRect(hit.pageView, item.rect);
    const { bg, fg } = this.sampleColors(hit, css);
    const layer = this.overlayFor(hit);
    const toCss = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
    const families = { sans: "Helvetica, Arial, sans-serif", serif: "'Times New Roman', Times, serif", mono: "'Courier New', monospace" };
    const editor = el("div", { class: "text-editor", contenteditable: "plaintext-only", spellcheck: "false" });
    editor.textContent = item.str;
    Object.assign(editor.style, {
      left: `${css.left}px`,
      top: `${css.top}px`,
      minWidth: `${css.width}px`,
      height: `${css.height}px`,
      lineHeight: `${css.height}px`,
      fontSize: `${item.size * hit.scale}px`,
      fontFamily: families[item.style.family],
      fontWeight: item.style.bold ? "700" : "400",
      fontStyle: item.style.italic ? "italic" : "normal",
      color: toCss(fg),
      background: toCss(bg),
    });
    layer.append(editor);
    this.editing = { kind: "text", hit, item, editor, bg, fg };
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.finishEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.clearEdit();
      }
      e.stopPropagation();
    });
    editor.addEventListener("blur", () => setTimeout(() => this.editing?.editor === editor && this.finishEdit(), 0));
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async commitText() {
    const { hit, item, editor, bg, fg } = this.editing;
    const text = editor.textContent.replace(/\n/g, " ");
    this.clearEdit();
    if (text === item.str) return;
    await this.run("Aplicando texto…", () =>
      hit.tab.edit((doc) => replaceText(doc, hit.pageIndex, { item, text, bg, color: fg, style: item.style })),
    );
  }

  startImageEdit(hit, image) {
    const layer = this.overlayFor(hit);
    const css = this.cssRect(hit.pageView, image.rect);
    const box = el("div", { class: "image-box" });
    for (const h of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) box.append(el("span", { class: "handle", dataset: { h } }));
    const bar = el("div", { class: "float-bar" }, [
      el("button", { class: "btn", type: "button", html: `${icon("image")}<span>Substituir</span>`, onclick: () => this.replaceImage() }),
      el("button", { class: "btn", type: "button", html: `${icon("trash")}<span>Excluir</span>`, onclick: () => this.deleteImage() }),
      el("button", { class: "btn primary", type: "button", text: "Concluir", onclick: () => this.commitImage() }),
    ]);
    layer.append(box, bar);
    this.editing = { kind: "image", hit, image, box, bar, rect: { ...css }, original: { ...css }, aspect: css.width / css.height };
    this.layoutImageBox();
    box.addEventListener("pointerdown", (e) => this.startImageDrag(e));
  }

  layoutImageBox() {
    const { box, bar, rect } = this.editing;
    Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    Object.assign(bar.style, { left: `${rect.left}px`, top: `${Math.max(0, rect.top - 40)}px` });
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
      const r = { ...startRect };
      if (!handle) {
        r.left += dx;
        r.top += dy;
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
    const { hit, rect } = this.editing;
    const vp = hit.pageView.viewport;
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

  async deleteImage() {
    const { hit, image } = this.editing;
    this.clearEdit();
    await this.run("Excluindo imagem…", () => hit.tab.edit((doc) => removeImage(doc, doc.getPage(hit.pageIndex), image.index)));
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

  async finishEdit() {
    if (!this.editing) return;
    if (this.editing.kind === "text") await this.commitText();
    else await this.commitImage();
  }

  clearEdit() {
    if (!this.editing) return;
    const { editor, box, bar } = this.editing;
    this.editing = null;
    editor?.remove();
    box?.remove();
    bar?.remove();
  }
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
