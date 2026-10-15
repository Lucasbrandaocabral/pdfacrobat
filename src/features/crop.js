// Recortar páginas: a página aparece grande com uma moldura ajustável (ou as
// margens em cm de cada lado) e o que fica fora dela some da página. Também
// acha sozinho as margens brancas, numa página ou em cada uma. O recorte muda
// a área visível (CropBox), como no Acrobat; Desfazer volta.
import { $, $$, UserError, debounce, el, formValues, parsePageRange, setBusy, toast } from "../ui.js";
import { Perm } from "../pdf/security.js";

const CM = 72 / 2.54;
// Menor pedaço que pode sobrar da página: 1 cm.
const MIN = CM;
const SIDES = ["top", "bottom", "left", "right"];

let dialog = null;
let form = null;
let s = null;

const fmt = (pt) => (pt / CM).toFixed(1).replace(".", ",");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setup() {
  if (dialog) return;
  dialog = $("#crop-tool");
  form = $("form", dialog);
  $("[data-tool-close]", dialog).addEventListener("click", () => dialog.close());
  for (const button of $$("[data-step]", dialog)) button.addEventListener("click", () => showPage(s.index + Number(button.dataset.step)));
  $("[data-auto]", dialog).addEventListener("click", autoCurrent);
  $("[data-reset]", dialog).addEventListener("click", () => setMargins({ top: 0, bottom: 0, left: 0, right: 0 }));
  $("[data-go]", dialog).addEventListener("click", go);
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("input", onInput);
  form.addEventListener("change", onInput);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  });
  for (const node of $$("[data-handle]", dialog)) {
    node.addEventListener("pointerdown", (event) => {
      // A alça dentro da moldura não pode virar "mover".
      event.stopPropagation();
      drag(event, node.dataset.handle);
    });
  }
  window.addEventListener("resize", debounce(() => s && draw(), 150));
  dialog.addEventListener("close", () => {
    s = null;
  });
}

/** Abre o recorte na página atual do documento ativo. */
export async function crop(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  if (!(await app.guard(tab, Perm.MODIFY, "recortar páginas"))) return;
  setup();
  const total = tab.doc.numPages;
  s = { app, tab, total, index: tab.viewer.currentPageNumber - 1, margins: { top: 0, bottom: 0, left: 0, right: 0 }, size: null, scale: 1, token: 0 };
  form.elements.scope.value = "current";
  form.elements.pages.value = "";
  form.elements.autoEach.checked = false;
  fillInputs();
  $("[data-doc]", dialog).textContent = tab.name;
  dialog.showModal();
  await showPage(s.index);
}

async function showPage(index) {
  if (!s || index < 0 || index >= s.total) return;
  s.index = index;
  $("[data-page-label]", dialog).textContent = `Página ${index + 1} de ${s.total}`;
  $('[data-step="-1"]', dialog).disabled = index === 0;
  $('[data-step="1"]', dialog).disabled = index === s.total - 1;
  const page = await s.tab.doc.getPage(index + 1);
  if (!s || s.index !== index) return;
  s.page = page;
  const base = page.getViewport({ scale: 1 });
  s.size = { w: base.width, h: base.height };
  await draw();
}

/** Desenha a página do tamanho que cabe na tela, com a moldura por cima. */
async function draw() {
  if (!s?.page) return;
  const token = ++s.token;
  const stage = $("[data-stage]", dialog);
  const room = Math.min((stage.clientWidth - 40) / s.size.w, (stage.clientHeight - 40) / s.size.h);
  if (!(room > 0)) return;
  s.scale = room;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const viewport = s.page.getViewport({ scale: room * ratio });
  const canvas = el("canvas", { class: "crop-canvas", width: Math.round(viewport.width), height: Math.round(viewport.height) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await s.page.render({ canvasContext: ctx, viewport }).promise;
  if (!s || token !== s.token) return;
  canvas.style.width = `${Math.round(s.size.w * room)}px`;
  canvas.style.height = `${Math.round(s.size.h * room)}px`;
  $(".crop-canvas", dialog).replaceWith(canvas);
  drawBox();
  showInfo();
}

function drawBox() {
  const { margins: m, scale: k, size } = s;
  const left = Math.min(m.left, size.w - MIN);
  const top = Math.min(m.top, size.h - MIN);
  for (const box of $$(".crop-box, .crop-shade", dialog)) {
    box.style.left = `${left * k}px`;
    box.style.top = `${top * k}px`;
    box.style.width = `${Math.max(MIN, size.w - left - m.right) * k}px`;
    box.style.height = `${Math.max(MIN, size.h - top - m.bottom) * k}px`;
  }
}

function fillInputs() {
  for (const side of SIDES) form.elements[side].value = fmt(s.margins[side]).replace(",", ".");
}

function setMargins(margins) {
  s.margins = { ...margins };
  fillInputs();
  drawBox();
  showInfo();
}

function onInput(event) {
  if (!s) return;
  const { name } = event.target;
  if (SIDES.includes(name)) {
    const value = Number(String(event.target.value).replace(",", "."));
    s.margins[name] = Number.isFinite(value) && value > 0 ? value * CM : 0;
    drawBox();
  }
  if (name === "pages") form.elements.scope.value = "range";
  showInfo();
}

/** Arrastar uma alça (ou a moldura toda, "move"). */
function drag(event, handle) {
  event.preventDefault();
  const start = { x: event.clientX, y: event.clientY, m: { ...s.margins } };
  const { w, h } = s.size;
  const target = event.currentTarget;
  target.setPointerCapture?.(event.pointerId);
  const move = (e) => {
    const dx = (e.clientX - start.x) / s.scale;
    const dy = (e.clientY - start.y) / s.scale;
    const m = { ...start.m };
    if (handle === "move") {
      const width = w - m.left - m.right;
      const height = h - m.top - m.bottom;
      m.left = clamp(start.m.left + dx, 0, w - width);
      m.right = w - width - m.left;
      m.top = clamp(start.m.top + dy, 0, h - height);
      m.bottom = h - height - m.top;
    } else {
      if (handle.includes("n")) m.top = clamp(start.m.top + dy, 0, h - m.bottom - MIN);
      if (handle.includes("s")) m.bottom = clamp(start.m.bottom - dy, 0, h - m.top - MIN);
      if (handle.includes("w")) m.left = clamp(start.m.left + dx, 0, w - m.right - MIN);
      if (handle.includes("e")) m.right = clamp(start.m.right - dx, 0, w - m.left - MIN);
    }
    setMargins(m);
  };
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

/**
 * Margens brancas da página (em pontos, na página como aparece), com uma
 * folguinha; null se a página estiver em branco.
 */
export async function whiteMargins(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, 800 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = el("canvas", { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const rows = new Uint32Array(height);
  const cols = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 235) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  // Uma linha ou coluna "tem tinta" com pelo menos alguns pontos escuros (ignora sujeira isolada).
  const minRow = Math.max(1, Math.round(width * 0.002));
  const minCol = Math.max(1, Math.round(height * 0.002));
  const first = (arr, min) => arr.findIndex((v) => v >= min);
  const last = (arr, min) => arr.length - 1 - [...arr].reverse().findIndex((v) => v >= min);
  const top = first(rows, minRow);
  if (top < 0) return null;
  const bottom = last(rows, minRow);
  const left = first(cols, minCol);
  const right = last(cols, minCol);
  const pad = 0.3 * CM;
  return {
    top: Math.max(0, top / scale - pad),
    bottom: Math.max(0, (height - 1 - bottom) / scale - pad),
    left: Math.max(0, left / scale - pad),
    right: Math.max(0, (width - 1 - right) / scale - pad),
  };
}

async function autoCurrent() {
  if (!s?.page) return;
  const margins = await whiteMargins(s.page);
  if (!margins) return toast("Esta página está em branco.");
  setMargins(margins);
}

/** Páginas a recortar (índices), ou lança UserError. */
function scopePages() {
  const v = formValues(form);
  if (v.scope === "all") return Array.from({ length: s.total }, (_, i) => i);
  if (v.scope === "range") {
    if (!v.pages.trim()) throw new UserError("Digite as páginas a recortar, por exemplo 1-3, 5.");
    return parsePageRange(v.pages, s.total);
  }
  return [s.index];
}

function showInfo() {
  if (!s?.size) return;
  const box = $(".tool-info", dialog);
  const v = formValues(form);
  let text = "";
  let error = null;
  try {
    const pages = scopePages();
    const where = pages.length === 1 ? `A página ${pages[0] + 1}` : `As ${pages.length} páginas`;
    if (v.autoEach) text = `${where} ${pages.length === 1 ? "perde" : "perdem"} as margens brancas, cada uma do seu tamanho.`;
    else {
      const { top, bottom, left, right } = s.margins;
      if (!(top || bottom || left || right)) text = "Arraste a moldura ou digite as margens para recortar.";
      else {
        const w = s.size.w - left - right;
        const h = s.size.h - top - bottom;
        if (w < MIN - 0.5 || h < MIN - 0.5) error = "Sobra muito pouco da página: deixe pelo menos 1 cm de cada lado.";
        else text = `${where} ${pages.length === 1 ? "fica" : "ficam"} com ${fmt(w)} × ${fmt(h)} cm${pages.length === 1 ? ` (era ${fmt(s.size.w)} × ${fmt(s.size.h)} cm)` : " (nesta página)"}.`;
      }
    }
  } catch (err) {
    error = err.userMessage || err.message;
  }
  box.textContent = error || text;
  box.classList.toggle("error", Boolean(error));
  const nothing = !v.autoEach && !SIDES.some((side) => s.margins[side] > 0);
  $("[data-go]", dialog).disabled = Boolean(error) || nothing;
}

async function go() {
  if (!s) return;
  let pages;
  try {
    pages = scopePages();
  } catch (err) {
    return showInfo();
  }
  const { app, tab, margins } = s;
  const autoEach = form.elements.autoEach.checked;
  const current = s.index;
  dialog.close();
  await app.run("Recortando…", async () => {
    // A área que fica, em coordenadas do PDF de cada página (vale para páginas giradas).
    const boxes = [];
    for (const [k, index] of pages.entries()) {
      if (pages.length > 3) setBusy(`Recortando… ${k + 1}/${pages.length}`);
      const page = await tab.doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const m = autoEach ? await whiteMargins(page) : margins;
      if (!m) continue;
      const left = Math.min(m.left, viewport.width - MIN);
      const top = Math.min(m.top, viewport.height - MIN);
      const right = Math.max(left + MIN, viewport.width - m.right);
      const bottom = Math.max(top + MIN, viewport.height - m.bottom);
      const [x0, y0] = viewport.convertToPdfPoint(left, bottom);
      const [x1, y1] = viewport.convertToPdfPoint(right, top);
      boxes.push({ index, x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });
    }
    if (!boxes.length) throw new UserError("Nada para recortar: as páginas estão em branco.");
    setBusy("Recortando…");
    await tab.edit((doc) => boxes.forEach((b) => doc.getPage(b.index).setCropBox(b.x, b.y, b.width, b.height)), { keepView: false, page: current + 1 });
    toast(`${boxes.length === 1 ? "Página recortada" : `${boxes.length} páginas recortadas`}. Para voltar, use Desfazer.`, { duration: 5000 });
  });
}
