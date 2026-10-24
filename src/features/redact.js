// Tarjar informações: marque áreas na página (arrastando) ou procure um texto
// ou dados pessoais (CPF, CNPJ, e-mail, telefone, CEP, datas) em todas as
// páginas. Ao tarjar, o que está debaixo das marcas sai do arquivo — texto,
// imagens, comentários e campos — e fica uma tarja preta no lugar.
import { $, $$, UserError, debounce, el, setBusy, toast } from "../ui.js";
import { icon } from "../icons.js";
import { Perm, dropUnreachable } from "../pdf/security.js";
import { LOAD_OPTIONS, pdfjsLib } from "../pdfjs.js";
import { textLines } from "../pdf/textops.js";
import { PATTERNS, cleanMetadata, findMatches, redactPage, removeHiddenCopies, replaceWithImage } from "../pdf/redact.js";

// Menor marca desenhada à mão, em pixels da tela.
const MIN_DRAG = 4;
// Zoom sobre "página inteira na tela".
const ZOOMS = [1, 1.5, 2, 3, 4];

let dialog = null;
let form = null;
let s = null;
let nextId = 1;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const NOT_FOUND = {
  cpf: "Nenhum CPF encontrado",
  cnpj: "Nenhum CNPJ encontrado",
  email: "Nenhum e-mail encontrado",
  phone: "Nenhum telefone encontrado",
  cep: "Nenhum CEP encontrado",
  date: "Nenhuma data encontrada",
};
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  if (dialog) return;
  dialog = $("#redact-tool");
  form = $("form", dialog);
  $("[data-tool-close]", dialog).addEventListener("click", () => dialog.close());
  for (const button of $$("[data-step]", dialog)) button.addEventListener("click", () => showPage(s.index + Number(button.dataset.step)));
  for (const button of $$("[data-zoom]", dialog)) button.addEventListener("click", () => setZoom(Number(button.dataset.zoom)));
  $("[data-pan]", dialog).addEventListener("click", () => setPanning(!s.panning));
  $("[data-search]", dialog).addEventListener("click", () => search({ term: form.elements.term.value }));
  for (const chip of $$("[data-pattern]", dialog)) chip.addEventListener("click", () => search({ pattern: chip.dataset.pattern }));
  $("[data-clear]", dialog).addEventListener("click", clearMarks);
  $("[data-go]", dialog).addEventListener("click", go);
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("change", () => showInfo());
  form.elements.term.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    search({ term: form.elements.term.value });
  });
  $("[data-layer]", dialog).addEventListener("pointerdown", startDraw);
  dialog.addEventListener("keydown", (event) => {
    if (!s?.selected || !["Delete", "Backspace"].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    removeMark(s.selected);
  });
  window.addEventListener("resize", debounce(() => s && draw(), 150));
  dialog.addEventListener("close", () => {
    s = null;
  });
}

/** Abre a tela de tarjar na página atual do documento ativo. */
export async function redact(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  if (!(await app.guard(tab, Perm.MODIFY, "tarjar informações"))) return;
  setup();
  // As marcas ficam guardadas enquanto o documento não mudar (fechar a tela sem querer não as perde).
  const marks = tab.redactMarks?.doc === tab.doc ? tab.redactMarks.marks : new Map();
  tab.redactMarks = { doc: tab.doc, marks };
  s = { app, tab, total: tab.doc.numPages, index: tab.viewer.currentPageNumber - 1, marks, selected: null, notice: null, lines: new Map(), editable: null, busy: false, token: 0, zoom: 1, panning: false };
  setPanning(false);
  // Uma busca interrompida (a tela fechou no meio) deixou os botões desativados.
  setEnabled(true);
  $("[data-doc]", dialog).textContent = tab.name;
  form.elements.term.value = "";
  dialog.showModal();
  showInfo();
  await showPage(s.index);
}

async function showPage(index) {
  if (!s || index < 0 || index >= s.total) return;
  s.index = index;
  s.selected = null;
  $("[data-page-label]", dialog).textContent = `Página ${index + 1} de ${s.total}`;
  $('[data-step="-1"]', dialog).disabled = index === 0;
  $('[data-step="1"]', dialog).disabled = index === s.total - 1;
  renderPages();
  const page = await s.tab.doc.getPage(index + 1);
  if (!s || s.index !== index) return;
  s.page = page;
  s.viewport = page.getViewport({ scale: 1 });
  await draw();
  $("[data-stage]", dialog).scrollTo(0, 0);
}

function setZoom(step) {
  if (!s) return;
  const at = ZOOMS.indexOf(s.zoom);
  const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + step))];
  if (next === s.zoom) return;
  // O ponto no meio da tela continua no meio depois do zoom.
  const stage = $("[data-stage]", dialog);
  const page = $(".crop-page", dialog);
  const fx = (stage.scrollLeft + stage.clientWidth / 2 - page.offsetLeft) / page.offsetWidth;
  const fy = (stage.scrollTop + stage.clientHeight / 2 - page.offsetTop) / page.offsetHeight;
  s.zoom = next;
  draw().then(() => {
    if (!s) return;
    stage.scrollLeft = page.offsetLeft + fx * page.offsetWidth - stage.clientWidth / 2;
    stage.scrollTop = page.offsetTop + fy * page.offsetHeight - stage.clientHeight / 2;
  });
}

/** No toque, arrastar o dedo move a página (rolagem) em vez de marcar. */
function setPanning(on) {
  s.panning = on;
  $("[data-stage]", dialog).classList.toggle("panning", on);
  $("[data-pan]", dialog).setAttribute("aria-pressed", String(on));
}

/** Desenha a página do tamanho que cabe na tela, com as marcas por cima. */
async function draw() {
  if (!s?.page) return;
  const token = ++s.token;
  const stage = $("[data-stage]", dialog);
  const { width, height } = s.viewport;
  const room = Math.min((stage.clientWidth - 40) / width, (stage.clientHeight - 40) / height) * s.zoom;
  if (!(room > 0)) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  // Imagem de até ~16 milhões de pontos (limite do canvas nos celulares).
  const viewport = s.page.getViewport({ scale: Math.min(room * ratio, Math.sqrt(16e6 / (width * height))) });
  const canvas = el("canvas", { class: "crop-canvas", width: Math.round(viewport.width), height: Math.round(viewport.height) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await s.page.render({ canvasContext: ctx, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
  if (!s || token !== s.token) return;
  s.scale = room;
  $("[data-zoom-label]", dialog).textContent = `${Math.round((room * 72 * 100) / 96)}%`;
  $('[data-zoom="-1"]', dialog).disabled = s.zoom === ZOOMS[0];
  $('[data-zoom="1"]', dialog).disabled = s.zoom === ZOOMS.at(-1);
  canvas.style.width = `${Math.round(width * room)}px`;
  canvas.style.height = `${Math.round(height * room)}px`;
  $(".crop-canvas", dialog).replaceWith(canvas);
  drawMarks();
}

/** Retângulo na tela (pixels, a partir do canto da página) de uma área do PDF. */
function screenBox(rect) {
  const [a, b, c, d] = s.viewport.convertToViewportRectangle(rect);
  const k = s.scale;
  return { left: Math.min(a, c) * k, top: Math.min(b, d) * k, width: Math.abs(c - a) * k, height: Math.abs(d - b) * k };
}

/** Área do PDF [x0, y0, x1, y1] de um retângulo na tela. */
function pdfRect(x0, y0, x1, y1) {
  const k = s.scale;
  const [ax, ay] = s.viewport.convertToPdfPoint(x0 / k, y0 / k);
  const [bx, by] = s.viewport.convertToPdfPoint(x1 / k, y1 / k);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

const place = (node, box) => {
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
};

function drawMarks() {
  if (!s?.scale) return;
  const layer = $("[data-layer]", dialog);
  const marks = s.marks.get(s.index) || [];
  layer.replaceChildren(
    ...marks.map((mark) => {
      const node = el("div", { class: `redact-mark${mark.id === s.selected ? " selected" : ""}`, title: mark.label });
      place(node, screenBox(mark.rect));
      node.addEventListener("pointerdown", () => {
        // Clicar numa marca seleciona (Delete tira); arrastar começa outra marca.
        if (s.selected !== mark.id) s.justSelected = performance.now();
        s.selected = mark.id;
        for (const other of $$(".redact-mark", layer)) other.classList.toggle("selected", other === node);
      });
      const remove = el("button", { type: "button", class: "redact-remove", title: "Tirar esta marca", "aria-label": "Tirar esta marca", html: icon("close") });
      remove.addEventListener("pointerdown", (event) => event.stopPropagation());
      remove.addEventListener("click", () => {
        // O mesmo toque que selecionou a marca não a tira (o × aparece debaixo do dedo).
        if (performance.now() - (s.justSelected || 0) < 400) return;
        removeMark(mark.id);
      });
      node.append(remove);
      return node;
    }),
  );
}

/** Arrastar sobre a página marca uma área. */
function startDraw(event) {
  if (!s?.scale || s.panning || event.button > 0 || event.target.closest(".redact-remove")) return;
  event.preventDefault();
  const layer = event.currentTarget;
  // Para o Delete tirar a marca selecionada.
  layer.focus({ preventScroll: true });
  const origin = layer.getBoundingClientRect();
  const maxX = origin.width;
  const maxY = origin.height;
  const clampX = (x) => Math.min(maxX, Math.max(0, x - origin.left));
  const clampY = (y) => Math.min(maxY, Math.max(0, y - origin.top));
  const start = { x: clampX(event.clientX), y: clampY(event.clientY) };
  const preview = el("div", { class: "redact-mark drawing" });
  let end = start;
  try {
    layer.setPointerCapture(event.pointerId);
  } catch {
    // Sem captura, o arraste continua enquanto o dedo estiver sobre a página.
  }
  const move = (e) => {
    end = { x: clampX(e.clientX), y: clampY(e.clientY) };
    if (!preview.isConnected) layer.append(preview);
    place(preview, { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
  };
  const up = () => {
    layer.removeEventListener("pointermove", move);
    layer.removeEventListener("pointerup", up);
    layer.removeEventListener("pointercancel", cancel);
    preview.remove();
    if (!s || Math.abs(end.x - start.x) < MIN_DRAG || Math.abs(end.y - start.y) < MIN_DRAG) return;
    const mark = addMark(s.index, pdfRect(start.x, start.y, end.x, end.y), "Área marcada");
    if (mark) s.selected = mark.id;
    s.notice = null;
    drawMarks();
    renderPages();
    showInfo();
  };
  const cancel = () => {
    end = start;
    up();
  };
  layer.addEventListener("pointermove", move);
  layer.addEventListener("pointerup", up);
  layer.addEventListener("pointercancel", cancel);
}

/** Acrescenta uma marca (menos se já houver outra praticamente igual); devolve a marca nova. */
function addMark(index, rect, label) {
  const list = s.marks.get(index) || [];
  const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const same = list.some((m) => {
    const inter = [Math.max(m.rect[0], rect[0]), Math.max(m.rect[1], rect[1]), Math.min(m.rect[2], rect[2]), Math.min(m.rect[3], rect[3])];
    return area(inter) >= 0.9 * Math.max(area(m.rect), area(rect));
  });
  if (same) return null;
  const mark = { id: nextId++, rect, label };
  list.push(mark);
  s.marks.set(index, list);
  return mark;
}

function removeMark(id) {
  for (const [index, list] of s.marks) {
    const rest = list.filter((m) => m.id !== id);
    if (rest.length === list.length) continue;
    if (rest.length) s.marks.set(index, rest);
    else s.marks.delete(index);
  }
  if (s.selected === id) s.selected = null;
  s.notice = null;
  drawMarks();
  renderPages();
  showInfo();
}

function clearMarks() {
  s.marks.clear();
  s.selected = null;
  s.notice = null;
  drawMarks();
  renderPages();
  showInfo();
}

/** Procura em todas as páginas e marca o que achar. */
async function search({ term = "", pattern = null }) {
  if (!s || s.busy) return;
  if (!pattern && !term.trim()) {
    form.elements.term.focus();
    return;
  }
  const session = s;
  session.busy = true;
  setEnabled(false);
  const what = pattern ? PATTERNS[pattern].label.replace(/^./, (c) => c.toUpperCase()) : `“${term.trim()}”`;
  let found = 0;
  const pages = new Set();
  try {
    session.editable ||= await session.tab.loadEditable();
    const doc = session.editable;
    for (let i = 0; i < session.total; i++) {
      if (session !== s) return;
      if (!session.lines.has(i)) {
        if (session.total > 2) showInfo(`Procurando ${what}… página ${i + 1} de ${session.total}`);
        let lines = [];
        try {
          lines = textLines(doc, doc.getPage(i));
        } catch (err) {
          console.warn("texto da página", i + 1, err);
        }
        session.lines.set(i, lines);
        await nextFrame();
      }
      const label = pattern ? what : `Busca: ${term.trim()}`;
      for (const rect of findMatches(session.lines.get(i), { term, whole: form.elements.whole.checked, pattern })) {
        if (addMark(i, rect, label)) {
          found++;
          pages.add(i);
        }
      }
    }
  } catch (err) {
    console.error(err);
    session.notice = { text: err?.userMessage || "Não foi possível ler o texto do documento.", error: true };
  } finally {
    session.busy = false;
  }
  if (session !== s) return;
  setEnabled(true);
  if (!session.notice?.error) {
    const already = !found && findAny(term, pattern);
    session.notice = {
      text: found
        ? `${what}: ${plural(found, "ocorrência marcada", "ocorrências marcadas")} em ${plural(pages.size, "página", "páginas")}.`
        : already
          ? `${what}: tudo o que foi achado já estava marcado.`
          : `${pattern ? NOT_FOUND[pattern] : `${what} não foi encontrado`} no texto do documento. Páginas escaneadas sem texto reconhecido não entram na busca: marque à mão ou use antes Reconhecer texto (OCR).`,
      error: false,
    };
  }
  // Mostra a primeira página com marca nova, se a atual não tiver nenhuma.
  const first = [...pages].sort((a, b) => a - b)[0];
  if (first !== undefined && !(s.marks.get(s.index) || []).length) await showPage(first);
  else {
    drawMarks();
    renderPages();
  }
  showInfo();
}

function findAny(term, pattern) {
  for (const lines of s.lines.values()) if (findMatches(lines, { term, whole: form.elements.whole.checked, pattern }).length) return true;
  return false;
}

function setEnabled(on) {
  for (const node of $$("[data-search], [data-pattern], [data-clear], [data-go], [data-step]", dialog)) node.disabled = !on;
  if (on) {
    $('[data-step="-1"]', dialog).disabled = s.index === 0;
    $('[data-step="1"]', dialog).disabled = s.index === s.total - 1;
  }
}

/** Lista das páginas com marcas (clicar leva até a página). */
function renderPages() {
  const box = $("[data-pages]", dialog);
  const entries = [...s.marks].filter(([, list]) => list.length).sort((a, b) => a[0] - b[0]);
  box.replaceChildren(
    ...entries.map(([index, list]) =>
      el("button", {
        type: "button",
        class: `redact-page-link${index === s.index ? " active" : ""}`,
        text: `Página ${index + 1} · ${plural(list.length, "marca", "marcas")}`,
        onclick: () => showPage(index),
      }),
    ),
  );
}

function showInfo(progress = null) {
  if (!s) return;
  const total = [...s.marks.values()].reduce((sum, list) => sum + list.length, 0);
  const pages = [...s.marks.values()].filter((list) => list.length).length;
  $("[data-count]", dialog).textContent = total ? `${plural(total, "marca", "marcas")} em ${plural(pages, "página", "páginas")}` : "Nenhuma marca";
  $("[data-clear]", dialog).hidden = !total;
  const box = $(".tool-info", dialog);
  let text;
  if (progress) text = progress;
  else {
    const parts = [];
    if (s.notice) parts.push(s.notice.text);
    if (!total) parts.push("Arraste sobre a página para marcar o que esconder, ou procure acima.");
    else {
      parts.push(`Ao tarjar, o que está debaixo ${total === 1 ? "da marca" : "das marcas"} sai do arquivo de verdade e fica uma tarja preta no lugar. O resto do documento continua igual.`);
      if (form.elements.asImage.checked) parts.push(`${pages === 1 ? "A página tarjada vira imagem" : "As páginas tarjadas viram imagem"}: o texto ${pages === 1 ? "dela" : "delas"} deixa de ser selecionável.`);
    }
    text = parts.join(" ");
  }
  box.textContent = text;
  box.classList.toggle("error", Boolean(!progress && s.notice?.error));
  const go = $("[data-go]", dialog);
  go.disabled = !total || s.busy;
  $("[data-go-label]", dialog).textContent = total ? `Tarjar ${plural(total, "área", "áreas")}` : "Tarjar";
}

// ---- Aplicar ----

/** JPEG sem os blocos EXIF: o navegador não gira a imagem pela orientação da câmera (o PDF não gira). */
function withoutExif(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts = [bytes.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    // Início dos dados da imagem: o resto vai inteiro.
    if (marker === 0xda) break;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    const exif = marker === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === "Exif";
    if (!exif) parts.push(bytes.subarray(at, at + 2 + length));
    at += 2 + length;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** O JPEG com as caixas (pixels, origem no canto de cima) pintadas de preto; null se o navegador não der conta. */
async function editJpeg(bytes, boxes, width, height) {
  if (width * height > 40e6) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([withoutExif(bytes)], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  } catch {
    return null;
  }
  try {
    if (bitmap.width !== width || bitmap.height !== height) return null;
    const canvas = el("canvas", { width, height });
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = "#000";
    for (const [x0, y0, x1, y1] of boxes) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    canvas.width = canvas.height = 0;
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), width, height } : null;
  } finally {
    bitmap.close();
  }
}

/** Troca as páginas `indices` (já tarjadas) por uma imagem delas. */
async function rasterize(doc, indices) {
  const bytes = await doc.save({ useObjectStreams: false });
  const pdf = await pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes }).promise;
  try {
    for (const index of indices) {
      const page = await pdf.getPage(index + 1);
      // Sem girar: a imagem ocupa a área visível da página como ela está no arquivo.
      const base = page.getViewport({ scale: 1, rotation: 0 });
      const scale = Math.min(200 / 72, Math.sqrt(12e6 / (base.width * base.height)));
      const viewport = page.getViewport({ scale, rotation: 0 });
      const canvas = el("canvas", { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Comentários e campos que ficaram continuam como estão, por cima da imagem.
      await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      canvas.width = canvas.height = 0;
      if (!blob) throw new UserError("Não foi possível transformar a página em imagem (pouca memória?).");
      const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      await image.embed();
      replaceWithImage(doc, doc.getPage(index), image, page.view);
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
}

async function go() {
  if (!s || s.busy) return;
  const pages = [...s.marks].filter(([, list]) => list.length).sort((a, b) => a[0] - b[0]);
  if (!pages.length) return;
  const { app, tab } = s;
  const asImage = form.elements.asImage.checked;
  const metadata = form.elements.metadata.checked;
  const total = pages.reduce((sum, [, list]) => sum + list.length, 0);
  dialog.close();
  await app.run("Tarjando…", async () => {
    const result = await tab.edit(async (doc) => {
      const raster = [];
      const texts = [];
      for (const [k, [index, list]] of pages.entries()) {
        if (pages.length > 2) setBusy(`Tarjando… página ${k + 1} de ${pages.length}`);
        const report = await redactPage(doc, doc.getPage(index), list.map((m) => m.rect), { editJpeg });
        if (asImage || report.raster) raster.push(index);
        texts.push(...report.texts);
      }
      if (raster.length) {
        setBusy(raster.length > 1 ? "Transformando as páginas em imagem…" : "Transformando a página em imagem…");
        await rasterize(doc, raster);
      }
      removeHiddenCopies(doc, new Set(pages.map(([index]) => doc.getPage(index).ref)), texts);
      if (metadata) cleanMetadata(doc);
      // O conteúdo antigo das páginas não pode ir junto no arquivo.
      dropUnreachable(doc);
      return { raster };
    });
    tab.redactMarks = null;
    const forced = asImage ? [] : result.raster;
    let message = `${plural(total, "área tarjada", "áreas tarjadas")}: o que estava debaixo saiu do arquivo.`;
    if (forced.length) {
      const list = forced.map((i) => i + 1).join(", ");
      message += ` Para garantir, ${forced.length === 1 ? `a página ${list} virou imagem` : `as páginas ${list} viraram imagem`} (tinha conteúdo que não dá para limpar pedaço por pedaço).`;
    }
    toast(`${message} Para voltar, use Desfazer; salve para gravar.`, { duration: 8000 });
  });
}
