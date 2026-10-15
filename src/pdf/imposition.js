// Montagem das folhas de impressão, como no Acrobat: ajustar ao papel, tamanho
// real, reduzir as páginas grandes ou escala livre; pôster (uma página dividida
// em várias folhas); várias páginas por folha; livreto. O resultado é um PDF
// novo, vetorial, com as páginas do documento embutidas: o original não muda.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  StandardFonts,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setLineWidth,
  setStrokingGrayscaleColor,
  stroke,
} from "@cantoo/pdf-lib";
import { isolatePage, multiply, transformPoint } from "./content.js";
import { encodable } from "./textedit.js";

const CM = 72 / 2.54;
// Tamanhos de papel em pontos (retrato). `named`: nome que a impressão do Electron entende.
export const PAPERS = {
  a4: { label: "A4 (21 × 29,7 cm)", width: 595.28, height: 841.89, named: "A4" },
  carta: { label: "Carta (21,6 × 27,9 cm)", width: 612, height: 792, named: "Letter" },
  oficio: { label: "Ofício (21,6 × 35,6 cm)", width: 612, height: 1008, named: "Legal" },
  oficio2: { label: "Ofício II (21,6 × 33 cm)", width: 612.28, height: 935.43 },
  a3: { label: "A3 (29,7 × 42 cm)", width: 841.89, height: 1190.55, named: "A3" },
  a5: { label: "A5 (14,8 × 21 cm)", width: 419.53, height: 595.28, named: "A5" },
  tabloide: { label: "Tabloide (27,9 × 43,2 cm)", width: 792, height: 1224, named: "Tabloid" },
};

export const DEFAULTS = {
  mode: "size",
  paper: "a4",
  orientation: "auto",
  sizing: "fit",
  scale: 100,
  tileScale: 100,
  overlap: 0,
  cutMarks: true,
  labels: true,
  largeOnly: false,
  perSheet: 2,
  cols: 2,
  rows: 2,
  order: "horizontal",
  borders: false,
  autoRotate: true,
  bookletSides: "both",
  sheetFrom: 1,
  sheetTo: 0,
  binding: "left",
  fileName: "",
};

// Margem que quase toda impressora consegue imprimir, e o espaço entre as páginas numa folha.
const MARGIN = 12;
const GAP = 9;

const num = (obj) => (typeof obj?.asNumber === "function" ? obj.asNumber() : undefined);
const nameOf = (obj) => (obj instanceof PDFName ? obj.decodeText() : "");
const key = (name) => PDFName.of(name);

// ---- Comentários e formulários ----

const HIDDEN = 2;
const PRINT = 4;
const KEEP = {
  markups: () => true,
  document: (subtype) => subtype === "Widget",
  stamps: (subtype) => subtype === "Widget" || subtype === "Stamp",
  forms: (subtype) => subtype === "Widget",
};

const numbers = (array) => (array instanceof PDFArray ? array.asArray().map((v) => num(v)) : null);

/**
 * Passa para o conteúdo da página a aparência das anotações que saem na
 * impressão. `mode`: "markups" (todas), "document" (só os campos de
 * formulário), "stamps" (campos e carimbos) ou "forms" (só os campos, sem o
 * resto da página). As anotações deixam de existir na cópia.
 */
export function flattenAnnotations(doc, page, mode = "markups") {
  const keep = KEEP[mode] || KEEP.markups;
  const annots = page.node.lookup(key("Annots"));
  const draws = [];
  for (const entry of annots instanceof PDFArray ? annots.asArray() : []) {
    const annot = doc.context.lookup(entry);
    if (!(annot instanceof PDFDict)) continue;
    const subtype = nameOf(annot.lookup(key("Subtype")));
    const flags = num(annot.lookup(key("F"))) ?? 0;
    if (subtype === "Popup" || !keep(subtype) || flags & HIDDEN || !(flags & PRINT)) continue;
    const appearances = annot.lookup(key("AP"));
    if (!(appearances instanceof PDFDict)) continue;
    let ref = appearances.get(key("N"));
    let stream = doc.context.lookup(ref);
    // Caixas de seleção e botões: uma aparência para cada estado.
    if (stream instanceof PDFDict) {
      const state = annot.lookup(key("AS"));
      ref = state instanceof PDFName ? stream.get(state) : null;
      stream = ref ? doc.context.lookup(ref) : null;
    }
    if (!(stream instanceof PDFStream)) continue;
    const rect = numbers(annot.lookup(key("Rect")));
    const bbox = numbers(stream.dict.lookup(key("BBox")));
    if (!rect || rect.length !== 4 || !bbox || bbox.length !== 4 || rect.concat(bbox).some((v) => !Number.isFinite(v))) continue;
    const matrix = numbers(stream.dict.lookup(key("Matrix"))) || [1, 0, 0, 1, 0, 0];
    // A caixa da aparência, transformada pela matriz dela, vai para o retângulo da anotação.
    const corners = [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[1]],
      [bbox[0], bbox[3]],
      [bbox[2], bbox[3]],
    ].map(([x, y]) => transformPoint(matrix, x, y));
    const tx0 = Math.min(...corners.map((p) => p[0]));
    const ty0 = Math.min(...corners.map((p) => p[1]));
    const tw = Math.max(...corners.map((p) => p[0])) - tx0;
    const th = Math.max(...corners.map((p) => p[1])) - ty0;
    const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    if (tw <= 0 || th <= 0 || rx1 - rx0 <= 0 || ry1 - ry0 <= 0) continue;
    const sx = (rx1 - rx0) / tw;
    const sy = (ry1 - ry0) / th;
    stream.dict.set(key("Type"), key("XObject"));
    stream.dict.set(key("Subtype"), key("Form"));
    if (!(ref instanceof PDFRef)) ref = doc.context.register(stream);
    const name = page.node.newXObject("Anotacao", ref);
    const cm = [sx, 0, 0, sy, rx0 - sx * tx0, ry0 - sy * ty0].map((v) => Math.round(v * 10000) / 10000);
    draws.push(`q ${cm.join(" ")} cm ${name.asString()} Do Q`);
  }
  if (mode === "forms") {
    page.node.set(key("Contents"), doc.context.register(doc.context.flateStream(draws.join("\n"))));
  } else if (draws.length) {
    isolatePage(doc, page);
    page.node.addContentStream(doc.context.register(doc.context.flateStream(draws.join("\n"))));
  }
  page.node.delete(key("Annots"));
}

// ---- Plano das folhas ----

/** Medidas de cada página do documento: caixa visível (sem girar) e o giro dela. */
export function pageInfo(doc) {
  return doc.getPages().map((page, index) => {
    const box = page.getCropBox();
    return { index, number: index + 1, box, width: box.width, height: box.height, rotate: ((page.getRotation().angle % 360) + 360) % 360 };
  });
}

/** Tamanho com que a página aparece, girada `turn` graus a mais (sentido horário). */
function shown(p, turn = 0) {
  return (p.rotate + turn) % 180 ? [p.height, p.width] : [p.width, p.height];
}

function paperSize(o, landscape) {
  const { width, height } = PAPERS[o.paper] || PAPERS.a4;
  return landscape ? [height, width] : [width, height];
}

const isLandscape = (p) => {
  const [w, h] = shown(p);
  return w > h;
};

/** Escala para caber em w × h e se vale girar a página (giro automático). */
function fit(p, w, h, rotate) {
  const [dw, dh] = shown(p);
  const straight = Math.min(w / dw, h / dh);
  const turned = Math.min(w / dh, h / dw);
  return rotate && turned > straight * 1.001 ? { turn: 270, scale: turned } : { turn: 0, scale: straight };
}

/** Página centralizada no retângulo [x, y, w, h], na escala dada. */
function centered(p, turn, scale, x, y, w, h) {
  const [dw, dh] = shown(p, turn);
  return { page: p.index, turn, scale, x: x + (w - dw * scale) / 2, y: y + (h - dh * scale) / 2, w: dw * scale, h: dh * scale };
}

function planSize(pages, o) {
  const auto = o.orientation === "auto";
  const landscape = o.orientation === "landscape" || (auto && isLandscape(pages[0]));
  const [W, H] = paperSize(o, landscape);
  return pages.map((p) => {
    const fitted = fit(p, W - 2 * MARGIN, H - 2 * MARGIN, auto);
    const scale = { actual: 1, shrink: Math.min(1, fitted.scale), custom: (o.scale || 100) / 100 }[o.sizing] ?? fitted.scale;
    // Ajustar e reduzir respeitam a margem da impressora; tamanho real e escala livre centralizam na folha.
    const area = o.sizing === "fit" || o.sizing === "shrink" ? [MARGIN, MARGIN, W - 2 * MARGIN, H - 2 * MARGIN] : [0, 0, W, H];
    return { width: W, height: H, items: [centered(p, fitted.turn, scale, ...area)] };
  });
}

const GRIDS = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] };

/** Colunas e linhas na folha: na deitada, mais colunas; na em pé, mais linhas (para 2 e 6 por folha). */
function gridFor(o, landscape) {
  if (o.perSheet === "custom") return [Math.max(1, Math.min(10, o.cols | 0)), Math.max(1, Math.min(10, o.rows | 0))];
  const [a, b] = GRIDS[o.perSheet] || GRIDS[2];
  return landscape ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
}

function cellsOf(W, H, cols, rows) {
  return [(W - 2 * MARGIN - (cols - 1) * GAP) / cols, (H - 2 * MARGIN - (rows - 1) * GAP) / rows];
}

function planMultiple(pages, o) {
  // Na orientação automática, fica a que deixa as páginas maiores.
  const options = o.orientation === "auto" ? [false, true] : [o.orientation === "landscape"];
  let best = null;
  for (const landscape of options) {
    const [W, H] = paperSize(o, landscape);
    const [cols, rows] = gridFor(o, landscape);
    const [cw, ch] = cellsOf(W, H, cols, rows);
    // Desempate: sem precisar girar as páginas, a leitura fica mais natural.
    const score = pages.reduce((sum, p) => {
      const fitted = fit(p, cw, ch, o.autoRotate);
      return sum + fitted.scale * (fitted.turn ? 0.97 : 1);
    }, 0);
    if (!best || score > best.score * 1.001) best = { score, W, H, cols, rows, cw, ch };
  }
  const { W, H, cols, rows, cw, ch } = best;
  const per = cols * rows;
  const sheets = [];
  for (let start = 0; start < pages.length; start += per) {
    const items = pages.slice(start, start + per).map((p, k) => {
      let col;
      let row;
      if (o.order === "vertical" || o.order === "vertical-reverse") {
        col = Math.floor(k / rows);
        row = k % rows;
      } else {
        row = Math.floor(k / cols);
        col = k % cols;
      }
      if (o.order.endsWith("reverse")) col = cols - 1 - col;
      const x = MARGIN + col * (cw + GAP);
      const y = H - MARGIN - (row + 1) * ch - row * GAP;
      const fitted = fit(p, cw, ch, o.autoRotate);
      return { ...centered(p, fitted.turn, fitted.scale, x, y, cw, ch), border: o.borders };
    });
    sheets.push({ width: W, height: H, items });
  }
  return sheets;
}

/** Marcas de corte nos quatro cantos da área [x, y, w, h], do lado de fora. */
function cutMarks(x, y, w, h) {
  const gap = 6;
  const len = 18;
  const marks = [];
  for (const [cx, sx] of [
    [x, -1],
    [x + w, 1],
  ]) {
    for (const [cy, sy] of [
      [y, -1],
      [y + h, 1],
    ]) {
      marks.push([cx + sx * gap, cy, cx + sx * (gap + len), cy]);
      marks.push([cx, cy + sy * gap, cx, cy + sy * (gap + len)]);
    }
  }
  return marks;
}

function planPoster(pages, o) {
  const overlap = Math.max(0, Number(o.overlap) || 0) * CM;
  const margin = o.cutMarks || o.labels ? 36 : MARGIN;
  const scale = Math.max(1, Number(o.tileScale) || 100) / 100;
  const sheets = [];
  for (const p of pages) {
    const [dw, dh] = shown(p);
    const PW = dw * scale;
    const PH = dh * scale;
    // Orientação do papel: a escolhida, ou a que usa menos folhas.
    const options = o.orientation === "auto" ? [false, true] : [o.orientation === "landscape"];
    let best = null;
    for (const landscape of options) {
      const [W, H] = paperSize(o, landscape);
      const tw = W - 2 * margin;
      const th = H - 2 * margin;
      const step = [Math.max(1, tw - overlap), Math.max(1, th - overlap)];
      const cols = Math.max(1, Math.ceil((PW - overlap) / step[0] - 1e-6));
      const rows = Math.max(1, Math.ceil((PH - overlap) / step[1] - 1e-6));
      if (!best || cols * rows < best.cols * best.rows) best = { W, H, tw, th, step, cols, rows };
    }
    const { W, H, tw, th, step, cols, rows } = best;
    // "Somente páginas grandes": a página que cabe no papel sai inteira, sem dividir.
    if (o.largeOnly) {
      const fits = options.map((landscape) => paperSize(o, landscape)).find(([w, h]) => PW <= w + 0.5 && PH <= h + 0.5);
      if (fits) {
        const [w, h] = fits;
        const fitted = fit(p, w - 2 * MARGIN, h - 2 * MARGIN, false);
        sheets.push({ width: w, height: h, items: [centered(p, 0, Math.min(scale, fitted.scale), MARGIN, MARGIN, w - 2 * MARGIN, h - 2 * MARGIN)] });
        continue;
      }
    }
    // O pôster fica centralizado no conjunto das partes.
    const offX = (cols * tw - (cols - 1) * overlap - PW) / 2;
    const offY = (rows * th - (rows - 1) * overlap - PH) / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const item = {
          page: p.index,
          turn: 0,
          scale,
          x: margin + offX - c * step[0],
          y: H - margin - (offY + PH - r * step[1]),
          w: PW,
          h: PH,
          clip: [margin, margin, tw, th],
        };
        const sheet = { width: W, height: H, items: [item], marks: o.cutMarks ? cutMarks(margin, margin, tw, th) : [], labels: [] };
        if (o.labels) {
          const name = o.fileName ? `${o.fileName} · ` : "";
          sheet.labels.push({ text: `${name}página ${p.number} · parte ${r + 1}-${c + 1} (${rows} × ${cols})`, x: margin, y: Math.max(6, margin / 2 - 4), size: 7 });
        }
        sheets.push(sheet);
      }
    }
  }
  return sheets;
}

function planBooklet(pages, o) {
  const tall = o.binding.endsWith("tall");
  const right = o.binding.startsWith("right");
  const padded = [...pages];
  while (padded.length % 4) padded.push(null);
  const total = padded.length;
  const count = total / 4;
  // Duas páginas lado a lado na folha deitada; na encadernação "alta", uma em cima da outra na folha em pé.
  const [W, H] = paperSize(o, !tall);
  const slots = tall
    ? [
        [0, H / 2, W, H / 2],
        [0, 0, W, H / 2],
      ]
    : [
        [0, 0, W / 2, H],
        [W / 2, 0, W / 2, H],
      ];
  const from = Math.min(count, Math.max(1, o.sheetFrom | 0 || 1));
  const to = Math.min(count, Math.max(from, o.sheetTo | 0 || count));
  const sheets = [];
  for (let i = from - 1; i < to; i++) {
    let front = [padded[total - 1 - 2 * i], padded[2 * i]];
    let back = [padded[2 * i + 1], padded[total - 2 - 2 * i]];
    if (right) {
      front = front.reverse();
      back = back.reverse();
    }
    const sides = o.bookletSides === "front" ? [["front", front]] : o.bookletSides === "back" ? [["back", back]] : [["front", front], ["back", back]];
    for (const [side, pair] of sides) {
      const items = [];
      pair.forEach((p, k) => {
        if (!p) return;
        const [x, y, w, h] = slots[k];
        const area = [x + MARGIN, y + MARGIN, w - 2 * MARGIN, h - 2 * MARGIN];
        // Na encadernação alta a página deita (o lado da lombada fica na dobra).
        let turn = tall ? 90 : 0;
        let [dw, dh] = shown(p, turn);
        let scale = Math.min(area[2] / dw, area[3] / dh);
        if (o.autoRotate) {
          [dw, dh] = shown(p, (turn + 270) % 360);
          const turned = Math.min(area[2] / dw, area[3] / dh);
          if (turned > scale * 1.001) {
            turn = (turn + 270) % 360;
            scale = turned;
          }
        }
        items.push(centered(p, turn, scale, ...area));
      });
      sheets.push({ width: W, height: H, items, side, sheet: i + 1 });
    }
  }
  return { sheets, physical: to - from + 1 };
}

/**
 * Folhas a imprimir para as páginas `pages` (de pageInfo, já na ordem de
 * impressão) com as opções `options` (veja DEFAULTS). Cada folha tem o tamanho
 * do papel e as páginas posicionadas: x, y, escala, giro e recorte.
 */
export function planSheets(pages, options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!pages.length) return { sheets: [], physical: 0 };
  if (o.mode === "booklet") return planBooklet(pages, o);
  const sheets = o.mode === "poster" ? planPoster(pages, o) : o.mode === "multiple" ? planMultiple(pages, o) : planSize(pages, o);
  return { sheets, physical: sheets.length };
}

// ---- PDF das folhas ----

/** Matriz que gira a caixa da página (b × h) no sentido horário, de volta ao primeiro quadrante. */
function rotation(turn, width, height) {
  switch (turn) {
    case 90:
      return [0, -1, 1, 0, 0, width];
    case 180:
      return [-1, 0, 0, -1, width, height];
    case 270:
      return [0, 1, -1, 0, height, 0];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

const round = (v) => Math.round(v * 10000) / 10000;

/**
 * PDF com as folhas `indices` do plano (todas, se omitido), desenhadas a
 * partir das páginas de `source` (um PDFDocument já com as anotações
 * achatadas). Devolve os bytes.
 */
export async function renderSheets(source, plan, indices = null) {
  const out = await PDFDocument.create();
  const chosen = indices ? indices.map((i) => plan.sheets[i]).filter(Boolean) : plan.sheets;
  const info = pageInfo(source);
  const used = [...new Set(chosen.flatMap((sheet) => sheet.items.map((item) => item.page)))];
  const embedded = used.length
    ? await out.embedPages(
        used.map((i) => source.getPage(i)),
        used.map((i) => {
          const { x, y, width, height } = info[i].box;
          return { left: x, bottom: y, right: x + width, top: y + height };
        }),
      )
    : [];
  const byPage = new Map(used.map((i, k) => [i, embedded[k]]));
  let font = null;
  for (const sheet of chosen) {
    const page = out.addPage([sheet.width, sheet.height]);
    const names = new Map();
    for (const item of sheet.items) {
      const p = info[item.page];
      if (!names.has(item.page)) names.set(item.page, page.node.newXObject("Pagina", byPage.get(item.page).ref));
      const turn = (p.rotate + item.turn) % 360;
      const matrix = multiply(rotation(turn, p.width, p.height), [item.scale, 0, 0, item.scale, item.x, item.y]).map(round);
      const ops = [pushGraphicsState()];
      if (item.clip) ops.push(rectangle(...item.clip.map(round)), clip(), endPath());
      ops.push(concatTransformationMatrix(...matrix), drawObject(names.get(item.page)), popGraphicsState());
      page.pushOperators(...ops);
      if (item.border) {
        page.pushOperators(pushGraphicsState(), setStrokingGrayscaleColor(0.35), setLineWidth(0.5), rectangle(round(item.x), round(item.y), round(item.w), round(item.h)), stroke(), popGraphicsState());
      }
    }
    if (sheet.marks?.length) {
      const ops = [pushGraphicsState(), setStrokingGrayscaleColor(0), setLineWidth(0.5)];
      for (const [x1, y1, x2, y2] of sheet.marks) ops.push(moveTo(round(x1), round(y1)), lineTo(round(x2), round(y2)), stroke());
      ops.push(popGraphicsState());
      page.pushOperators(...ops);
    }
    for (const label of sheet.labels || []) {
      font ||= await out.embedFont(StandardFonts.Helvetica);
      page.drawText(encodable(label.text, font), { x: label.x, y: label.y, size: label.size, font, color: rgb(0.25, 0.25, 0.25) });
    }
  }
  return out.save();
}

/**
 * Campos de formulário sem aparência (comum quando o PDF pede ao leitor para
 * desenhá-los): gera uma, para que o valor saia na impressão.
 */
async function ensureAppearances(doc) {
  if (!(doc.catalog.lookup(key("AcroForm")) instanceof PDFDict)) return;
  let font = null;
  try {
    for (const field of doc.getForm().getFields()) {
      try {
        if (!field.needsAppearancesUpdate?.()) continue;
        font ||= await doc.embedFont(StandardFonts.Helvetica);
        field.defaultUpdateAppearances(font);
      } catch {
        // Campo que o pdf-lib não sabe desenhar: sai como estiver.
      }
    }
  } catch {
    // Formulário malformado: imprime sem mexer nos campos.
  }
  // O pdf-lib só grava a fonte ao salvar; esta cópia não é salva, só embutida nas folhas.
  if (font) await font.embed();
}

/**
 * Prepara o documento para imprimir: carrega `bytes`, aplica as anotações
 * conforme `annotations` (veja flattenAnnotations) nas páginas `indices`
 * (todas, se omitido) e devolve o PDFDocument.
 */
export async function printSource(bytes, annotations = "markups", indices = null) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  await ensureAppearances(doc);
  const pages = doc.getPages();
  for (const i of indices ?? pages.keys()) if (pages[i]) flattenAnnotations(doc, pages[i], annotations);
  return doc;
}

/** Páginas (índices) a imprimir: escolhidas, só ímpares ou pares, e na ordem inversa se pedido. */
export function choosePages(indices, { subset = "all", reverse = false } = {}) {
  let list = indices.filter((i) => subset === "all" || (subset === "odd" ? i % 2 === 0 : i % 2 === 1));
  if (reverse) list = list.reverse();
  return list;
}
