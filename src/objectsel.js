// Objetos na ferramenta "Editar texto e imagens", como no Acrobat. Clicar
// continua editando o texto ou a imagem; arrastar move qualquer objeto da
// página (parágrafo, imagem, desenho, degradê, grupo); com Alt ou Ctrl, o
// arrasto duplica; Shift+clique (ou Ctrl+clique) junta vários; arrastar na
// página, fora dos objetos, seleciona os que a área pegar. A alça redonda
// embaixo da seleção gira (em volta do meio dela). A barra da seleção gira
// 90°, duplica, copia, recorta e exclui; colar (Ctrl+V ou o botão Colar) põe
// os objetos em qualquer página, deste ou de outro documento aberto. No
// celular, segurar o dedo num objeto o seleciona; depois, tocar em outros
// junta mais e arrastar a seleção a move.
import { $, el, toast } from "./ui.js";
import { icon } from "./icons.js";
import { loadPdf } from "./pdfjs.js";
import { copyObjects, deleteObjects, moveObjects, pasteObjects, rotationAbout, textKey, transformObjects, unionRect } from "./pdf/objects.js";
import { dragRotation, normalizeAngle, rotateHandle, screenAngle } from "./rotate.js";

// Quanto o ponteiro anda (px) até contar como arrasto, por tipo de ponteiro.
const DRAG_START = { mouse: 4, pen: 6, touch: 10 };
const LONG_PRESS = 450;
// As setas movem um ponto por vez; a mudança é gravada quando elas param.
const NUDGE_COMMIT = 600;
const PASTE_STEP = 10;
const CLIP_TYPE = "application/x-pdf-acrobat-objetos";

const area = (r) => Math.max(1e-6, (r[2] - r[0]) * (r[3] - r[1]));
const inside = (r, x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const modifiers = (e) => ({ alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
const isTyping = (target) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// O que foi copiado ou recortado, para colar em qualquer página aberta.
let clipboard = null;

// O que cobre quase a página inteira é o fundo (comum no Canva).
const BACKGROUND = 0.85;

/**
 * O que dá para selecionar na página (de pageData): cada parágrafo inteiro,
 * como o clique pega para editar, e cada outro objeto. O texto invisível do
 * OCR vai junto com a imagem em que está. O fundo (`background`, o que cobre
 * quase toda a área `view` da página) não é pego por clique nem por arrasto:
 * clicar "no vazio" não o seleciona e arrastar ali faz a área de seleção. Em
 * ordem de desenho (o último fica por cima).
 */
export function objectUnits({ blocks = [], objects = [], images = [] }, view = null) {
  const visible = objects.filter((o) => o.rect && !o.hidden);
  const byKey = new Map(visible.map((o) => [o.key, o]));
  const taken = new Set();
  const units = [];
  for (const block of blocks) {
    const members = [];
    for (const line of block.lines) {
      for (const run of line.runs || []) {
        const obj = byKey.get(textKey(run));
        if (!obj || obj.invisible || taken.has(obj)) continue;
        taken.add(obj);
        members.push(obj);
      }
    }
    if (members.length) units.push({ kind: "text", members, block });
  }
  // Os trechos que não entraram nas linhas (os espaços entre as palavras, ou
  // todos, quando não deu para ligar as linhas ao conteúdo) vão para o
  // parágrafo em que estão, o menor deles: o título inteiro se move junto, e
  // não cada palavra. Espaço fora de qualquer parágrafo não desenha nada e fica de fora.
  const byBlock = new Map(units.map((u) => [u.block, u]));
  const smallest = [...blocks].sort((a, b) => area(a.rect) - area(b.rect));
  for (const obj of visible) {
    if (obj.kind !== "text" || obj.invisible || taken.has(obj)) continue;
    const cx = (obj.rect[0] + obj.rect[2]) / 2;
    const cy = (obj.rect[1] + obj.rect[3]) / 2;
    const block = smallest.find((b) => {
      const pad = 0.2 * (b.size || 0);
      return cx >= b.rect[0] - pad && cx <= b.rect[2] + pad && cy >= b.rect[1] - pad && cy <= b.rect[3] + pad;
    });
    if (block) {
      if (!byBlock.has(block)) {
        const unit = { kind: "text", members: [], block };
        units.push(unit);
        byBlock.set(block, unit);
      }
      byBlock.get(block).members.push(obj);
      taken.add(obj);
    } else if (obj.blank) taken.add(obj);
  }
  const pageImages = new Map(images.map((image) => [image.start, image]));
  const invisible = [];
  for (const obj of visible) {
    if (taken.has(obj)) continue;
    if (obj.kind === "text" && obj.invisible) invisible.push(obj);
    // A imagem desenhada direto na página também abre na caixa de imagem (tamanho, trocar).
    else units.push({ kind: obj.kind, members: [obj], image: obj.kind === "image" && !obj.scope ? pageImages.get(obj.start) : undefined });
  }
  for (const obj of invisible) {
    const cx = (obj.rect[0] + obj.rect[2]) / 2;
    const cy = (obj.rect[1] + obj.rect[3]) / 2;
    const holder = units.filter((u) => ["image", "inline", "form"].includes(u.kind) && u.members[0].index < obj.index && inside(u.members[0].rect, cx, cy)).pop();
    if (holder) holder.members.push(obj);
    else units.push({ kind: "text", members: [obj], invisible: true });
  }
  const pageArea = view ? Math.abs((view[2] - view[0]) * (view[3] - view[1])) : Infinity;
  for (const unit of units) {
    unit.keys = unit.members.map((o) => o.key);
    unit.rect = unionRect(unit.members.filter((o) => unit.invisible || !o.invisible).map((o) => o.rect));
    unit.order = unit.members.reduce((max, o) => Math.max(max, o.index), -1);
    unit.background = unit.kind !== "text" && area(unit.rect) >= BACKGROUND * pageArea;
  }
  return units.sort((a, b) => a.order - b.order);
}

/** O objeto no ponto [x, y] (coordenadas do PDF): o menor que o contém; empatados, o de cima. */
export function unitAt(units, [x, y], pad = 1) {
  let best = null;
  for (const unit of units) {
    if (unit.invisible || unit.background) continue;
    const [x0, y0, x1, y1] = unit.rect;
    if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) continue;
    if (!best || area(unit.rect) <= area(best.rect)) best = unit;
  }
  return best;
}

/** O texto dos parágrafos selecionados, para colar em outros programas. */
function selectionText(units) {
  return units
    .filter((u) => u.kind === "text" && u.block)
    .map((u) => u.block.text)
    .join("\n");
}

const sameList = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

export class ObjectSelection {
  constructor(tools) {
    this.tools = tools;
    this.gesture = null;
    // Copiar, recortar e colar pelos eventos da área de transferência: assim
    // valem o teclado, o menu Editar do app no computador e o do sistema.
    document.addEventListener("copy", (e) => this.onClipboard(e, "copy"));
    document.addEventListener("cut", (e) => this.onClipboard(e, "cut"));
    document.addEventListener("paste", (e) => this.onClipboard(e, "paste"));
    $("#opt-select-all")?.addEventListener("click", () => this.selectAll());
    $("#opt-paste")?.addEventListener("click", () => this.paste());
    this.updatePasteButton();
  }

  /** A seleção de objetos aberta (null se não há, ou se a edição aberta é outra). */
  get editing() {
    const editing = this.tools.editing;
    return editing?.kind === "objects" ? editing : null;
  }

  // ---- Ponteiro ----

  /**
   * Começo de um toque ou clique na página com a ferramenta Editar. Decide no
   * fim (clique) ou quando o ponteiro anda (arrasto): para isso escuta o
   * ponteiro até ele soltar.
   */
  press(e, hit) {
    const tools = this.tools;
    this.closeMenu();
    if (tools.editing && !this.editing) {
      // Com um texto ou uma imagem em edição, o clique fora conclui (como antes).
      tools.finishEdit();
      return;
    }
    if (this.editing?.busy) return;
    const g = {
      hit,
      id: e.pointerId,
      type: e.pointerType || "mouse",
      start: [e.clientX, e.clientY],
      last: [e.clientX, e.clientY],
      mods: modifiers(e),
      state: "pending",
      data: null,
      unit: null,
      // No toque, arrastar só move o que já está selecionado (fora disso, rola a página).
      onSelection: Boolean(e.target.closest?.(".object-outline")),
    };
    this.gesture = g;
    const move = (ev) => ev.pointerId === g.id && this.onMove(g, ev);
    const end = (ev, cancel) => {
      if (ev.pointerId !== g.id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancelled, true);
      clearTimeout(g.timer);
      if (this.gesture === g) this.gesture = null;
      if (cancel) this.onCancel(g);
      else this.onUp(g, ev);
    };
    const up = (ev) => end(ev, false);
    const cancelled = (ev) => end(ev, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancelled, true);
    if (g.type === "touch") g.timer = setTimeout(() => this.onLongPress(g), LONG_PRESS);
    g.ready = tools
      .pageData(hit.tab, hit.pageNumber)
      .then((data) => {
        g.data = data;
        g.unit = unitAt(data.units || [], hit.pdf);
        if (g.state === "waiting") this.startDrag(g);
      })
      .catch((err) => console.warn("Sem os objetos da página:", err));
  }

  onMove(g, ev) {
    g.last = [ev.clientX, ev.clientY];
    g.mods = modifiers(ev);
    if (g.state === "drag") return this.dragTo(g);
    if (g.state === "band") return this.bandTo(g);
    if (g.state !== "pending") return;
    if (Math.hypot(g.last[0] - g.start[0], g.last[1] - g.start[1]) < (DRAG_START[g.type] ?? 4)) return;
    clearTimeout(g.timer);
    if (g.type === "touch" && !g.onSelection) {
      g.state = "ignored";
      return;
    }
    if (!g.data) g.state = "waiting";
    else this.startDrag(g);
  }

  async onUp(g) {
    if (g.state === "drag") return this.drop(g);
    if (g.state === "band") return this.finishBand(g);
    if (g.state === "pending" || g.state === "waiting") {
      await g.ready;
      this.click(g);
    }
  }

  onCancel(g) {
    if (g.state === "band") g.band?.remove();
    const editing = this.editing;
    if (g.state === "drag" && editing) {
      editing.dragging = false;
      editing.offset = [0, 0];
      this.layout(editing);
    }
  }

  /**
   * No celular, segurar o dedo num objeto o seleciona (ou o junta à seleção);
   * numa parte vazia da página, abre ali "Colar aqui" e "Selecionar tudo".
   */
  async onLongPress(g) {
    if (g.state !== "pending") return;
    await g.ready;
    if (g.state !== "pending" || !g.data) return;
    g.state = "long";
    navigator.vibrate?.(15);
    if (!g.unit) return this.openMenu(g.hit);
    const editing = this.editing;
    const current = this.samePage(editing, g.hit) ? editing.units : [];
    this.select(g.hit, current.includes(g.unit) ? current : [...current, g.unit], g.data);
  }

  /** Barrinha no ponto tocado de uma parte vazia da página. */
  openMenu(hit) {
    this.closeMenu();
    this.tools.clearEdit();
    const button = (name, label, onclick) =>
      el("button", {
        class: "btn",
        type: "button",
        html: `${icon(name)}<span>${label}</span>`,
        onclick: () => {
          this.closeMenu();
          onclick();
        },
      });
    const menu = el("div", { class: "float-bar page-bar" }, [
      clipboard ? button("paste", "Colar aqui", () => this.paste({ pageNumber: hit.pageNumber, at: hit.pdf })) : null,
      button("selectAll", "Selecionar tudo", () => this.selectAll(hit.pageNumber)),
    ]);
    const layer = this.tools.overlayFor(hit);
    layer.append(menu);
    const left = Math.max(0, Math.min(hit.x - menu.offsetWidth / 2, layer.clientWidth - menu.offsetWidth));
    const top = hit.y - menu.offsetHeight - 16 >= 0 ? hit.y - menu.offsetHeight - 16 : hit.y + 16;
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
    this.menu = menu;
  }

  closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  samePage(editing, hit) {
    return Boolean(editing && editing.hit.tab === hit.tab && editing.hit.pageNumber === hit.pageNumber);
  }

  click(g) {
    const { hit, data, unit, mods } = g;
    if (!data) return;
    const tools = this.tools;
    const editing = this.editing;
    const same = this.samePage(editing, hit);
    // Juntando vários: Shift/Ctrl+clique, ou toques depois de selecionar no celular.
    if (mods.shift || mods.ctrl || (g.type === "touch" && same)) {
      if (!unit) {
        if (!(mods.shift || mods.ctrl)) tools.clearEdit();
        return;
      }
      const current = same ? editing.units : [];
      const next = current.includes(unit) ? current.filter((u) => u !== unit) : [...current, unit];
      if (next.length) this.select(hit, next, data);
      else tools.clearEdit();
      return;
    }
    if (editing) tools.clearEdit();
    // Um clique edita o texto ou a imagem, como antes. Um desenho (menor que o
    // texto em volta, como um ícone) é selecionado.
    const target = tools.hitTest(data, hit.pdf);
    const targetRect = target && (target.kind === "text" ? target.block.rect : target.image.rect);
    if (unit && unit.kind !== "text" && !unit.image && (!target || area(unit.rect) < area(targetRect))) {
      this.select(hit, [unit], data);
    } else if (target?.kind === "text") {
      tools.startTextEdit(hit, target.block);
    } else if (target?.kind === "image") {
      tools.startImageEdit(hit, target.image);
    } else if (unit) {
      this.select(hit, [unit], data);
    } else if (!editing) {
      tools.explainNothingHere(data);
    }
  }

  // ---- Arrastar ----

  startDrag(g) {
    const { unit, hit, mods } = g;
    const editing = this.editing;
    const current = this.samePage(editing, hit) ? editing.units : [];
    if (!unit) {
      // Na página, fora dos objetos: área de seleção (só com mouse ou caneta).
      if (g.type === "touch") {
        g.state = "ignored";
        return;
      }
      g.state = "band";
      g.base = mods.shift || mods.ctrl ? current : [];
      this.bandTo(g);
      return;
    }
    const units = current.includes(unit) ? current : mods.shift ? [...current, unit] : [unit];
    const selection = this.select(hit, units, g.data);
    selection.dragging = true;
    g.state = "drag";
    this.tools.removeHover();
    this.dragTo(g);
  }

  dragTo(g) {
    const editing = this.editing;
    if (!editing?.dragging) return;
    let dx = g.last[0] - g.start[0];
    let dy = g.last[1] - g.start[1];
    // Shift: só na horizontal ou só na vertical.
    if (g.mods.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    editing.offset = [dx, dy];
    editing.duplicate = g.mods.alt || g.mods.ctrl;
    this.layout(editing);
  }

  drop() {
    const editing = this.editing;
    if (!editing) return;
    editing.dragging = false;
    if (Math.hypot(...editing.offset) < 1) {
      editing.offset = [0, 0];
      this.layout(editing);
      return;
    }
    this.tools.track(this.commitTransform(editing, { keep: editing.duplicate }));
  }

  bandTo(g) {
    const layer = this.tools.overlayFor(g.hit);
    if (!g.band) {
      g.band = el("div", { class: "object-band" });
      layer.append(g.band);
    }
    const box = layer.getBoundingClientRect();
    const [x0, y0] = [g.start[0] - box.left, g.start[1] - box.top];
    const [x1, y1] = [g.last[0] - box.left, g.last[1] - box.top];
    g.bandRect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    Object.assign(g.band.style, { left: `${g.bandRect[0]}px`, top: `${g.bandRect[1]}px`, width: `${g.bandRect[2] - g.bandRect[0]}px`, height: `${g.bandRect[3] - g.bandRect[1]}px` });
  }

  finishBand(g) {
    g.band?.remove();
    if (!g.data || !g.bandRect) return;
    const vp = g.hit.pageView.viewport;
    const a = vp.convertToPdfPoint(g.bandRect[0], g.bandRect[1]);
    const b = vp.convertToPdfPoint(g.bandRect[2], g.bandRect[3]);
    const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    // O fundo só entra se a área o pegar inteiro.
    const contains = (r) => rect[0] <= r[0] && rect[1] <= r[1] && rect[2] >= r[2] && rect[3] >= r[3];
    const picked = (g.data.units || []).filter((u) => !u.invisible && overlaps(u.rect, rect) && (!u.background || contains(u.rect)));
    const units = [...g.base, ...picked.filter((u) => !g.base.includes(u))];
    if (units.length) this.select(g.hit, units, g.data);
    else this.tools.clearEdit();
  }

  // ---- Seleção ----

  /** Seleciona `units` (de pageData) na página de `hit`, com os contornos e a barra. */
  select(hit, units, data) {
    const tools = this.tools;
    let editing = this.editing;
    if (editing && !this.samePage(editing, hit)) {
      this.finishPending(editing);
      tools.clearEdit();
      editing = null;
    }
    if (!editing) {
      if (tools.editing) tools.clearEdit();
      const layer = tools.overlayFor(hit);
      const box = el("div", { class: "object-selection" });
      const bar = this.buildBar();
      const rotator = rotateHandle("object-rotate");
      rotator.addEventListener("pointerdown", (e) => this.startRotate(e));
      layer.append(box, bar);
      editing = { kind: "objects", hit, layer, box, bar, rotator, units: [], data, viewport: hit.pageView.viewport, offset: [0, 0], turn: 0, duplicate: false };
      editing.dispose = () => this.dispose(editing);
      tools.editing = editing;
    }
    const changed = !sameList(editing.units.flatMap((u) => u.keys), units.flatMap((u) => u.keys));
    editing.units = units;
    editing.data = data;
    tools.removeHover();
    this.layout(editing, { rebuild: true });
    if (changed) this.preparePreview(editing);
    return editing;
  }

  dispose(editing) {
    this.closeMenu();
    clearTimeout(editing.nudgeTimer);
    clearTimeout(editing.previewTimer);
    editing.previewToken = null;
    editing.ghost?.remove();
  }

  buildBar() {
    const button = (name, label, title, onclick) =>
      el("button", { class: "btn", type: "button", title, html: `${icon(name)}<span>${label}</span>`, onclick });
    const turn = (name, title, angle) =>
      el("button", { class: "btn icon-only", type: "button", title, "aria-label": title, html: icon(name), onclick: () => this.rotateBy(angle) });
    return el("div", { class: "float-bar object-bar" }, [
      el("span", { class: "float-hint object-count" }),
      turn("rotateCcw", "Girar 90° para a esquerda", -Math.PI / 2),
      turn("rotateCw", "Girar 90° para a direita", Math.PI / 2),
      button("duplicate", "Duplicar", "Duplicar (ou arraste com Alt ou Ctrl)", () => this.duplicate()),
      button("copy", "Copiar", "Copiar (Ctrl+C)", () => this.copy({ cut: false })),
      button("cut", "Recortar", "Recortar (Ctrl+X)", () => this.copy({ cut: true })),
      button("trash", "Excluir", "Excluir (Delete)", () => this.remove()),
    ]);
  }

  /** Posiciona os contornos, a prévia do arrasto (ou do giro), a alça de girar e a barra. */
  layout(editing, { rebuild = false } = {}) {
    const tools = this.tools;
    const { box, bar, rotator, units, offset, hit, layer } = editing;
    if (rebuild) {
      // Num fragmento: milhares de contornos (Ctrl+A numa página cheia) espalhados como argumentos estourariam a pilha.
      const outlines = document.createDocumentFragment();
      for (const unit of units) {
        const r = tools.cssRect(hit.pageView, unit.rect);
        const outline = el("div", { class: `object-outline kind-${unit.kind}` });
        Object.assign(outline.style, { left: `${r.left - 1}px`, top: `${r.top - 1}px`, width: `${r.width + 2}px`, height: `${r.height + 2}px` });
        outlines.append(outline);
      }
      // A alça vai junto com os contornos: gira e se desloca com eles.
      box.replaceChildren(outlines, rotator);
      bar.querySelector(".object-count").textContent = plural(units.length, "objeto", "objetos");
    }
    const union = tools.cssRect(hit.pageView, unionRect(units.map((u) => u.rect)));
    const turn = editing.turn || 0;
    const moved = Boolean(offset[0] || offset[1]);
    const changed = moved || Boolean(turn);
    const transform = [moved ? `translate(${offset[0]}px, ${offset[1]}px)` : "", turn ? `rotate(${turn}rad)` : ""].join(" ").trim();
    const pivot = `${union.left + union.width / 2}px ${union.top + union.height / 2}px`;
    Object.assign(box.style, { transform, transformOrigin: pivot });
    box.classList.toggle("moving", Boolean(editing.dragging || editing.rotating || changed));
    box.classList.toggle("dragging", Boolean(editing.dragging));
    box.classList.toggle("duplicating", Boolean(editing.duplicate && (editing.dragging || moved)));
    // No arrasto (e no giro), a página sem os objetos (quando não é para
    // duplicar) e eles por cima, onde vão ficar.
    if (editing.ghost) {
      editing.ghost.hidden = !changed;
      Object.assign(editing.ghost.style, { transform, transformOrigin: pivot });
    }
    if (editing.clean) editing.clean.hidden = !changed || editing.duplicate;
    bar.hidden = Boolean(editing.dragging || editing.rotating);
    if (bar.hidden) return;
    // A alça de girar no meio, embaixo da seleção (em cima, quando não cabe
    // embaixo, perto do fim da página); a barra fica do outro lado, ou além da alça.
    const size = rotator.offsetWidth || 26;
    const bottom = union.top + union.height;
    const handleBelow = bottom + 12 + size <= layer.clientHeight || union.top - 12 - size < 0;
    const handleTop = handleBelow ? bottom + 12 : union.top - 12 - size;
    Object.assign(rotator.style, { left: `${union.left + union.width / 2 - size / 2}px`, top: `${handleTop}px` });
    const left = Math.max(0, Math.min(union.left + offset[0], layer.clientWidth - bar.offsetWidth));
    const above = (handleBelow ? union.top : handleTop) + offset[1] - bar.offsetHeight - 10;
    const top = above >= 0 ? above : (handleBelow ? handleTop + size : bottom) + offset[1] + 10;
    Object.assign(bar.style, { left: `${left}px`, top: `${Math.min(top, Math.max(0, layer.clientHeight - bar.offsetHeight))}px` });
  }

  /**
   * Prepara a prévia do arrasto: a página sem os objetos e os objetos sozinhos
   * (o mesmo PDF que copiar faria, desenhado sem fundo).
   */
  preparePreview(editing) {
    const token = {};
    editing.previewToken = token;
    clearTimeout(editing.previewTimer);
    editing.previewTimer = setTimeout(async () => {
      const tools = this.tools;
      const pageCanvas = editing.hit.pageDiv.querySelector(".canvasWrapper canvas");
      if (!pageCanvas) return;
      const keys = editing.units.flatMap((u) => u.keys);
      try {
        const lib = await tools.libDoc(editing.hit.tab);
        const clip = await copyObjects(lib, editing.hit.pageIndex, keys);
        const [clean, ghost] = await Promise.all([
          tools.renderPageCopy(editing, pageCanvas, (doc, page) => {
            deleteObjects(doc, page, keys);
          }),
          this.renderClip(editing, pageCanvas, clip.pdf),
        ]);
        if (editing.previewToken !== token || tools.editing !== editing) return;
        editing.clean?.remove();
        editing.ghost?.remove();
        editing.clip = { ...clip, keys };
        if (clean) {
          editing.layer.prepend(clean);
          editing.clean = clean;
        }
        // Por cima da página limpa e embaixo dos contornos.
        ghost.classList.add("object-ghost");
        editing.box.before(ghost);
        editing.ghost = ghost;
        this.layout(editing);
      } catch (err) {
        console.warn("Sem prévia dos objetos:", err);
      }
    }, 120);
  }

  /** Desenha o PDF `pdf` (da área de transferência) sem fundo, no tamanho da página na tela. */
  async renderClip(editing, pageCanvas, pdf) {
    const { viewport, hit } = editing;
    const { doc } = await loadPdf(pdf, { worker: hit.tab.worker });
    try {
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: viewport.scale, rotation: viewport.rotation });
      const canvas = el("canvas");
      canvas.width = pageCanvas.width;
      canvas.height = pageCanvas.height;
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: vp,
        transform: [canvas.width / vp.width, 0, 0, canvas.height / vp.height, 0, 0],
        background: "rgba(0, 0, 0, 0)",
      }).promise;
      return canvas;
    } finally {
      doc.destroy();
    }
  }

  /** O zoom recria as camadas da página: a seleção volta no lugar, na escala nova. */
  followZoom(editing) {
    const tools = this.tools;
    editing.viewport = editing.hit.pageView.viewport;
    editing.layer = tools.overlayFor(editing.hit);
    editing.clean?.remove();
    editing.ghost?.remove();
    editing.clean = editing.ghost = null;
    editing.layer.append(editing.box, editing.bar);
    this.layout(editing, { rebuild: true });
    this.preparePreview(editing);
  }

  // ---- Ações ----

  /**
   * Grava na seleção o deslocamento (`editing.offset`, em px da tela) e o giro
   * (`editing.turn`, em volta do meio dela), ou duplica (`keep`).
   */
  async commitTransform(editing, { keep = false, reselect = true } = {}) {
    const { hit, offset, units } = editing;
    const turn = editing.turn || 0;
    const vp = hit.pageView.viewport;
    const a = vp.convertToPdfPoint(0, 0);
    const b = vp.convertToPdfPoint(offset[0], offset[1]);
    const delta = [b[0] - a[0], b[1] - a[1]];
    const keys = units.flatMap((u) => u.keys);
    const r = unionRect(units.map((u) => u.rect));
    // A tela tem o y para baixo: o horário dela é o anti-horário do PDF (com a página girada também).
    const matrix = turn ? rotationAbout([(r[0] + r[2]) / 2, (r[1] + r[3]) / 2], -turn, delta) : null;
    editing.busy = true;
    clearTimeout(editing.nudgeTimer);
    const { tab, pageIndex, pageNumber } = hit;
    const label = keep ? "Duplicando…" : turn ? "Girando…" : "Movendo…";
    const moved = await this.tools.run(label, () =>
      tab.edit((doc) => (matrix ? transformObjects(doc, pageIndex, keys, matrix, { keep }) : moveObjects(doc, pageIndex, keys, delta, { keep }))),
    );
    if (this.tools.editing === editing) {
      // Não deu certo (o documento não recarregou): a seleção volta para o lugar.
      editing.busy = false;
      editing.offset = [0, 0];
      editing.turn = 0;
      this.layout(editing);
    }
    if (moved?.length && reselect) await this.reselect(tab, pageNumber, moved);
  }

  /**
   * O ângulo na tela que a seleção já tem (para os ímãs do giro): o do texto
   * ou da imagem, quando é um objeto só; 0 nos outros casos.
   */
  baseAngle(editing) {
    const [unit] = editing.units;
    if (editing.units.length !== 1) return 0;
    const vp = editing.viewport;
    if (unit.kind === "text" && unit.block) return screenAngle(vp, unit.block.angle || 0);
    const m = unit.members[0]?.ctm;
    if (["image", "inline", "form"].includes(unit.kind) && m) return screenAngle(vp, Math.atan2(m[1], m[0]));
    return 0;
  }

  /** Alça de girar: gira a seleção com o ponteiro; ao soltar, grava. */
  startRotate(e) {
    const editing = this.editing;
    if (!editing || editing.busy || editing.dragging || e.button > 0) return;
    const tools = this.tools;
    const union = tools.cssRect(editing.hit.pageView, unionRect(editing.units.map((u) => u.rect)));
    const page = editing.layer.getBoundingClientRect();
    const pivot = [page.left + union.left + union.width / 2 + editing.offset[0], page.top + union.top + union.height / 2 + editing.offset[1]];
    clearTimeout(editing.nudgeTimer);
    editing.rotating = true;
    tools.removeHover();
    dragRotation(e, pivot, {
      base: this.baseAngle(editing),
      onTurn: (turn) => {
        editing.turn = turn;
        this.layout(editing);
      },
      onEnd: (turn) => {
        editing.rotating = false;
        if (tools.editing !== editing) return;
        if (turn === null || Math.abs(normalizeAngle(turn)) < 0.003) {
          editing.turn = 0;
          this.layout(editing);
          // Um deslocamento das setas ainda não gravado: grava como antes.
          if (editing.offset[0] || editing.offset[1]) editing.nudgeTimer = setTimeout(() => tools.track(this.commitTransform(editing)), NUDGE_COMMIT);
          return;
        }
        editing.turn = turn;
        tools.track(this.commitTransform(editing));
      },
    });
  }

  /** Botões da barra: gira a seleção `angle` radianos (90° para um lado ou para o outro). */
  async rotateBy(angle) {
    const editing = this.editing;
    if (!editing || editing.busy) return;
    editing.turn = angle;
    this.layout(editing);
    await this.tools.track(this.commitTransform(editing));
  }

  /** Depois de mudar o documento, seleciona de novo os objetos `keys` (na página recarregada). */
  async reselect(tab, pageNumber, keys) {
    await tab.loaded;
    const tools = this.tools;
    if (tools.tool !== "edit" || tools.manager.active !== tab || tools.editing) return;
    const data = await tools.pageData(tab, pageNumber);
    const wanted = new Set(keys);
    const units = (data.units || []).filter((u) => u.keys.some((k) => wanted.has(k)));
    const hit = tools.pageHitFor(tab, pageNumber);
    if (units.length && hit && !tools.editing) this.select(hit, units, data);
  }

  /** Grava um deslocamento das setas que ainda não foi gravado (sem selecionar de novo). */
  finishPending(editing) {
    if (!editing || editing.busy || editing.rotating || !(editing.offset[0] || editing.offset[1])) return null;
    return this.commitTransform(editing, { reselect: false });
  }

  /** Concluir (antes de salvar, trocar de ferramenta...): grava o que ficou pendente e solta a seleção. */
  async finish() {
    const editing = this.editing;
    if (!editing) return;
    const pending = this.finishPending(editing);
    if (pending) await pending;
    if (this.tools.editing === editing) this.tools.clearEdit();
  }

  nudge([dx, dy]) {
    const editing = this.editing;
    const scale = editing.viewport.scale;
    editing.offset = [editing.offset[0] + dx * scale, editing.offset[1] + dy * scale];
    editing.duplicate = false;
    this.layout(editing);
    clearTimeout(editing.nudgeTimer);
    editing.nudgeTimer = setTimeout(() => this.tools.track(this.commitTransform(editing)), NUDGE_COMMIT);
  }

  async remove() {
    const editing = this.editing;
    if (!editing || editing.busy) return;
    const { hit, units } = editing;
    const keys = units.flatMap((u) => u.keys);
    this.tools.clearEdit();
    await this.tools.track(this.tools.run("Excluindo…", () => hit.tab.edit((doc) => deleteObjects(doc, hit.pageIndex, keys))));
  }

  /** Duplicar pela barra: a cópia fica um pouco ao lado, selecionada. */
  async duplicate() {
    const editing = this.editing;
    if (!editing || editing.busy) return;
    const scale = editing.viewport.scale;
    editing.offset = [PASTE_STEP * scale, PASTE_STEP * scale];
    await this.tools.track(this.commitTransform(editing, { keep: true }));
  }

  /** Guarda a seleção para colar (recortar também a tira da página). */
  async copy({ cut = false, id = String(Math.random()).slice(2) } = {}) {
    const editing = this.editing;
    if (!editing || editing.busy) return;
    const { hit, units } = editing;
    const keys = units.flatMap((u) => u.keys);
    const text = selectionText(units);
    let clip = editing.clip && sameList(editing.clip.keys, keys) ? editing.clip : null;
    try {
      if (!clip) {
        const lib = await this.tools.libDoc(hit.tab);
        clip = await copyObjects(lib, hit.pageIndex, keys);
      }
    } catch (err) {
      console.error(err);
      toast("Não foi possível copiar esses objetos.", { kind: "error" });
      return;
    }
    clipboard = { pdf: clip.pdf, rect: clip.rect, count: units.length, id, text, tab: hit.tab, pageNumber: hit.pageNumber, cut, pasted: [] };
    this.updatePasteButton();
    if (!cut) {
      const how = matchMedia("(pointer: coarse)").matches ? "segure o dedo na página onde quer pôr" : "use Ctrl+V ou o botão Colar";
      toast(`${plural(units.length, "objeto copiado", "objetos copiados")}. Para colar, ${how}, nesta ou em outra página.`, { duration: 5000 });
      return;
    }
    this.tools.clearEdit();
    await this.tools.track(this.tools.run("Recortando…", () => hit.tab.edit((doc) => deleteObjects(doc, hit.pageIndex, keys))));
  }

  /**
   * Cola o que foi copiado na página que está sob o mouse, na da seleção ou na
   * atual. No mesmo lugar, a não ser na própria página de onde veio (aí um
   * pouco ao lado a cada vez) ou quando o lugar fica fora da página.
   */
  async paste({ pageNumber = null, at = null } = {}) {
    const tools = this.tools;
    const tab = tools.tab;
    if (!tab?.doc || !clipboard) return;
    pageNumber ??= this.targetPage(tab);
    await tools.settled();
    const clip = clipboard;
    const lib = await tools.libDoc(tab);
    const page = lib.getPage(pageNumber - 1);
    // Cada vez que cola na mesma página, um pouco mais ao lado (na página de
    // onde veio, já a primeira: o original continua lá, a não ser recortado).
    const same = (t) => t.tab === tab && t.pageNumber === pageNumber;
    const count = clip.pasted.filter(same).length + (same(clip) && !clip.cut ? 1 : 0);
    clip.pasted.push({ tab, pageNumber });
    let delta = [PASTE_STEP * count, -PASTE_STEP * count];
    // "Colar aqui": com o meio dos objetos no ponto tocado.
    if (at && clip.rect) delta = [at[0] - (clip.rect[0] + clip.rect[2]) / 2, at[1] - (clip.rect[1] + clip.rect[3]) / 2];
    const box = page.getCropBox();
    const view = [box.x, box.y, box.x + box.width, box.y + box.height];
    const r = clip.rect && [clip.rect[0] + delta[0], clip.rect[1] + delta[1], clip.rect[2] + delta[0], clip.rect[3] + delta[1]];
    if (r && !(r[0] >= view[0] - 1 && r[1] >= view[1] - 1 && r[2] <= view[2] + 1 && r[3] <= view[3] + 1)) {
      // Fora da página (outro tamanho, por exemplo): no meio dela.
      delta = [(view[0] + view[2]) / 2 - (clip.rect[0] + clip.rect[2]) / 2, (view[1] + view[3]) / 2 - (clip.rect[1] + clip.rect[3]) / 2];
    }
    const keys = await tools.run("Colando…", () => tab.edit((doc) => pasteObjects(doc, pageNumber - 1, clip.pdf, delta)));
    if (keys?.length) await this.reselect(tab, pageNumber, keys);
  }

  /** A página para colar ou selecionar tudo: a que está sob o mouse, a da seleção ou a atual. */
  targetPage(tab) {
    const { lastPage } = this.tools;
    const editing = this.editing;
    if (lastPage?.tab === tab) return lastPage.pageNumber;
    if (editing?.hit.tab === tab) return editing.hit.pageNumber;
    return tab.viewer.currentPageNumber;
  }

  async selectAll(pageNumber = null) {
    const tools = this.tools;
    const tab = tools.tab;
    if (!tab?.doc || tools.tool !== "edit") return;
    const editing = this.editing;
    if (tools.editing && !editing) await tools.finishEdit();
    pageNumber ??= this.targetPage(tab);
    const data = await tools.pageData(tab, pageNumber);
    const units = (data.units || []).filter((u) => !u.invisible);
    if (!units.length) return toast("Não há objetos para selecionar nesta página.");
    const hit = tools.pageHitFor(tab, pageNumber);
    if (hit) this.select(hit, units, data);
  }

  updatePasteButton() {
    const button = $("#opt-paste");
    if (!button) return;
    button.disabled = !clipboard;
    button.title = clipboard ? `Colar ${plural(clipboard.count, "objeto", "objetos")} (Ctrl+V)` : "Copie ou recorte objetos para colar";
  }

  // ---- Teclado e área de transferência ----

  /**
   * As teclas e a área de transferência valem fora dos campos e do painel
   * lateral: numa miniatura, Delete continua excluindo a página, e na lista
   * de comentários Ctrl+C copia o texto selecionado.
   */
  ours(target) {
    return !isTyping(target) && !target?.closest?.("#sidebar");
  }

  /** Teclas da seleção. Devolve true se a tecla foi usada. */
  key(e) {
    const tools = this.tools;
    if (tools.tool !== "edit" || !this.ours(e.target)) return false;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "a" && (!tools.editing || this.editing)) {
      e.preventDefault();
      this.selectAll();
      return true;
    }
    const editing = this.editing;
    if (!editing || editing.busy || editing.dragging) return false;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.remove();
      return true;
    }
    const step = e.shiftKey ? 10 : 1;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (nudge && !mod) {
      e.preventDefault();
      this.nudge(nudge);
      return true;
    }
    return false;
  }

  onClipboard(e, action) {
    const tools = this.tools;
    if (tools.tool !== "edit" || !this.ours(e.target) || document.querySelector("dialog[open]")) return;
    if (action === "paste") {
      if (!clipboard) return;
      // Copiado depois, em outro lugar (outro texto, uma imagem): não é o nosso.
      const data = e.clipboardData;
      const types = [...(data?.types || [])];
      const ours = !types.length || data.getData(CLIP_TYPE) === clipboard.id || (clipboard.text && data.getData("text/plain") === clipboard.text && !types.includes("Files"));
      if (!ours) return;
      e.preventDefault();
      this.paste();
      return;
    }
    const editing = this.editing;
    if (!editing || editing.busy) return;
    e.preventDefault();
    // No computador, o mesmo Ctrl+C pode chegar pela página e pelo menu Editar:
    // o segundo só repete o que o primeiro pôs na área de transferência.
    const now = performance.now();
    const keys = editing.units.flatMap((u) => u.keys).join(" ");
    const last = this.lastCopy;
    if (last && now - last.time < 400 && last.keys === keys && last.action === action) {
      e.clipboardData?.setData(CLIP_TYPE, last.id);
      if (last.text) e.clipboardData?.setData("text/plain", last.text);
      return;
    }
    const id = String(Math.random()).slice(2);
    const text = selectionText(editing.units);
    e.clipboardData?.setData(CLIP_TYPE, id);
    if (text) e.clipboardData?.setData("text/plain", text);
    this.lastCopy = { time: now, keys, action, id, text };
    this.copy({ cut: action === "cut", id });
  }
}
