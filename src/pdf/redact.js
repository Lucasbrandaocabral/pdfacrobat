// Tarjar de verdade: o que fica debaixo de cada tarja sai do arquivo — o texto
// (letra por letra, inclusive o texto invisível do OCR), as imagens (os pontos
// cobertos ficam pretos) e os comentários e campos de formulário — e um
// retângulo preto cobre a área. Quando algo não dá para limpar com segurança
// (imagem num formato que não se edita aqui, texto que não se localiza), a
// página é marcada para virar imagem (`raster`).
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, rgb } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import { decodeStream, isolatePage, multiply, parseOperations, readPageContent, transformPoint, unitBox } from "./content.js";
import { pageCopies, redactText } from "./textops.js";

const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_DEPTH = 6;
const key = (name) => PDFName.of(name);
const nameOf = (obj) => (obj instanceof PDFName ? obj.decodeText() : "");
const num = (obj) => (typeof obj?.asNumber === "function" ? obj.asNumber() : undefined);
const numbers = (array) => (array instanceof PDFArray ? array.asArray().map((_, i) => num(array.lookup(i))) : null);
const pathOf = (scope) => (scope ? `${pathOf(scope.parent)}/${scope.name}` : "");

/** As caixas [x0, y0, x1, y1] se sobrepõem? */
export const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!det) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Imagens desenhadas na página, com o formulário em que estão (`scope`, no
 * formato de findTextRuns). `repeated`: dentro de um formulário desenhado mais
 * de uma vez, que não dá para mudar só num lugar; `inline`: embutida no
 * conteúdo (BI ... EI).
 */
export function imagePlacements(doc, page) {
  const found = [];
  const visit = (content, resources, scope, start, depth, repeated) => {
    const xobjects = resources?.lookup(key("XObject"));
    const ops = parseOperations(content);
    const uses = new Map();
    for (const o of ops) {
      if (o.op === "Do" && o.operands[0]?.type === "name") uses.set(o.operands[0].value, (uses.get(o.operands[0].value) || 0) + 1);
    }
    let ctm = start;
    const stack = [];
    for (const o of ops) {
      if (o.op === "q") stack.push(ctm);
      else if (o.op === "Q") ctm = stack.pop() || start;
      else if (o.op === "cm") {
        const n = o.operands.map((t) => t.value);
        if (n.length === 6 && n.every((v) => typeof v === "number")) ctm = multiply(n, ctm);
      } else if (o.op === "BI") found.push({ inline: true, scope, ctm, rect: unitBox(ctm), repeated });
      else if (o.op === "Do") {
        const name = o.operands[0]?.type === "name" ? o.operands[0].value : null;
        const stream = name && xobjects instanceof PDFDict ? xobjects.lookup(key(name)) : null;
        if (!(stream instanceof PDFStream)) continue;
        const subtype = nameOf(stream.dict.lookup(key("Subtype")));
        if (subtype === "Image") found.push({ name, stream, scope, ctm, rect: unitBox(ctm), repeated });
        // Formulário fundo demais: o texto dele já deixa a página em dúvida (redactText).
        else if (subtype === "Form" && depth < MAX_DEPTH) {
          let inner;
          try {
            inner = decodeStream(stream);
          } catch {
            continue;
          }
          const m = numbers(stream.dict.lookup(key("Matrix")));
          const own = stream.dict.lookup(key("Resources"));
          const child = { name, stream, parent: scope, resources: own instanceof PDFDict ? own : resources };
          const matrix = m?.length === 6 && m.every(Number.isFinite) ? m : IDENTITY;
          visit(inner, child.resources, child, multiply(matrix, ctm), depth + 1, repeated || uses.get(name) !== 1);
        }
      }
    }
  };
  visit(readPageContent(doc, page), page.node.Resources(), null, IDENTITY, 0, false);
  return found;
}

/** Caixas em pontos da imagem (origem no canto de cima) que as áreas cobrem. */
function pixelBoxes(ctm, width, height, rects) {
  const inverse = invert(ctm);
  if (!inverse) return null;
  return rects.map((r) => {
    const pts = [
      [r[0], r[1]],
      [r[2], r[1]],
      [r[0], r[3]],
      [r[2], r[3]],
    ].map(([x, y]) => transformPoint(inverse, x, y));
    const xs = pts.map((p) => p[0] * width);
    const ys = pts.map((p) => (1 - p[1]) * height);
    return [
      Math.max(0, Math.floor(Math.min(...xs)) - 1),
      Math.max(0, Math.floor(Math.min(...ys)) - 1),
      Math.min(width, Math.ceil(Math.max(...xs)) + 1),
      Math.min(height, Math.ceil(Math.max(...ys)) + 1),
    ];
  });
}

// ---- Pontos das imagens ----

const DECODABLE = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);

function filtersOf(dict) {
  const filter = dict.lookup(key("Filter"));
  if (filter instanceof PDFArray) return filter.asArray().map((_, i) => nameOf(filter.lookup(i)));
  return filter ? [nameOf(filter)] : [];
}

/** Quantos valores tem cada ponto no espaço de cor; 0 quando não dá para saber. */
function colorComponents(doc, space) {
  const value = space instanceof PDFRef ? doc.context.lookup(space) : space;
  if (value instanceof PDFName) return { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4, CalGray: 1, CalRGB: 3 }[value.decodeText()] || 0;
  if (!(value instanceof PDFArray)) return 0;
  const family = nameOf(value.lookup(0));
  if (family === "ICCBased") return num(value.lookup(1)?.dict?.lookup(key("N"))) || 0;
  if (family === "Indexed" || family === "Separation" || family === "CalGray") return 1;
  if (family === "CalRGB" || family === "Lab") return 3;
  if (family === "DeviceN") {
    const names = value.lookup(1);
    return names instanceof PDFArray ? names.size() : 0;
  }
  return 0;
}

/** Desfaz o previsor PNG (cada linha com o seu filtro). */
function unPng(data, colors, bpc, columns) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const length = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (length + 1));
  const out = new Uint8Array(rows * length);
  let prev = new Uint8Array(length);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (length + 1)];
    const line = data.subarray(r * (length + 1) + 1, (r + 1) * (length + 1));
    const cur = out.subarray(r * length, (r + 1) * length);
    for (let i = 0; i < length; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (type !== 0) return null;
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

/** Desfaz o previsor TIFF (só com 8 bits por valor). */
function unTiff(data, colors, columns) {
  const length = colors * columns;
  const out = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at++) {
    const i = at % length;
    out[at] = (data[at] + (i >= colors ? out[at - colors] : 0)) & 0xff;
  }
  return out;
}

/** Os valores dos pontos, sem compressão, linha a linha; null num formato que não dá para editar aqui. */
function decodeSamples(stream) {
  const filters = filtersOf(stream.dict);
  if (!(stream instanceof PDFRawStream) || filters.some((f) => !DECODABLE.has(f))) return null;
  let data;
  try {
    data = decodePDFRawStream(stream).decode();
  } catch {
    return null;
  }
  const parms = stream.dict.lookup(key("DecodeParms"));
  for (let i = 0; i < filters.length; i++) {
    const p = parms instanceof PDFArray ? parms.lookup(i) : filters.length === 1 ? parms : null;
    const predictor = p instanceof PDFDict ? (num(p.lookup(key("Predictor"))) ?? 1) : 1;
    if (predictor <= 1) continue;
    // Previsor no meio da cadeia de filtros: raro, e o pdf-lib não o desfaz.
    if (i !== filters.length - 1) return null;
    const colors = num(p.lookup(key("Colors"))) ?? 1;
    const bpc = num(p.lookup(key("BitsPerComponent"))) ?? 8;
    const columns = num(p.lookup(key("Columns"))) ?? 1;
    data = predictor >= 10 ? unPng(data, colors, bpc, columns) : predictor === 2 && bpc === 8 ? unTiff(data, colors, columns) : null;
    if (!data) return null;
  }
  return data;
}

/**
 * Cópia do stream de pontos (imagem ou máscara) com as caixas `boxes` zeradas
 * (pretas em CMYK); null quando não dá para editar.
 */
function blackenSamples(doc, stream, boxes, { width, height, comps, bpc }) {
  const data = decodeSamples(stream);
  if (!data) return null;
  const stride = Math.ceil((width * comps * bpc) / 8);
  if (data.length < stride * height) return null;
  const out = data.slice(0, stride * height);
  const black = comps === 4 && bpc === 8 ? [0, 0, 0, 255] : null;
  for (const [x0, y0, x1, y1] of boxes) {
    const left = Math.max(0, x0);
    const right = Math.min(width, x1);
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      const row = y * stride;
      if (black) for (let x = left; x < right; x++) out.set(black, row + x * 4);
      else out.fill(0, row + Math.floor((left * comps * bpc) / 8), row + Math.ceil((right * comps * bpc) / 8));
    }
  }
  const dict = stream.dict.clone(doc.context);
  for (const name of ["Filter", "DecodeParms", "Length", "DL"]) dict.delete(key(name));
  dict.set(key("Filter"), key("FlateDecode"));
  return PDFRawStream.of(dict, zlibSync(out));
}

/**
 * Imagem nova (registrada) com as caixas pintadas de preto, e as máscaras de
 * transparência também (elas guardam o contorno do que estava ali); null
 * quando o formato não dá para editar aqui.
 */
async function redactImage(doc, stream, boxes, editJpeg) {
  const { dict } = stream;
  const width = num(dict.lookup(key("Width")));
  const height = num(dict.lookup(key("Height")));
  const stencil = dict.lookup(key("ImageMask"))?.asBoolean?.() === true;
  const comps = stencil ? 1 : colorComponents(doc, dict.lookup(key("ColorSpace")));
  const bpc = stencil ? 1 : num(dict.lookup(key("BitsPerComponent")));
  if (!width || !height || !comps || !bpc) return null;
  const filters = filtersOf(dict);
  let result;
  if (filters.length === 1 && filters[0] === "DCTDecode") {
    // JPEG: quem sabe abrir e gravar é o navegador.
    if (!editJpeg || stencil || ![1, 3].includes(comps) || dict.has(key("Decode"))) return null;
    const edited = await editJpeg(stream.getContents(), boxes, width, height);
    if (!edited) return null;
    const copy = dict.clone(doc.context);
    for (const name of ["Filter", "DecodeParms", "Length"]) copy.delete(key(name));
    copy.set(key("Filter"), key("DCTDecode"));
    copy.set(key("BitsPerComponent"), PDFNumber.of(8));
    copy.set(key("Width"), PDFNumber.of(edited.width));
    copy.set(key("Height"), PDFNumber.of(edited.height));
    if (comps === 1) copy.set(key("ColorSpace"), key("DeviceRGB"));
    result = PDFRawStream.of(copy, edited.bytes);
  } else {
    result = blackenSamples(doc, stream, boxes, { width, height, comps, bpc });
    if (!result) return null;
  }
  for (const name of ["SMask", "Mask"]) {
    const mask = dict.lookup(key(name));
    if (!(mask instanceof PDFStream)) continue;
    const mw = num(mask.dict.lookup(key("Width")));
    const mh = num(mask.dict.lookup(key("Height")));
    if (!mw || !mh) return null;
    const scaled = boxes.map(([x0, y0, x1, y1]) => [
      Math.floor((x0 * mw) / width),
      Math.floor((y0 * mh) / height),
      Math.ceil((x1 * mw) / width),
      Math.ceil((y1 * mh) / height),
    ]);
    const maskBpc = name === "Mask" ? 1 : num(mask.dict.lookup(key("BitsPerComponent"))) || 8;
    const edited = blackenSamples(doc, mask, scaled, { width: mw, height: mh, comps: 1, bpc: maskBpc });
    if (!edited) return null;
    result.dict.set(key(name), doc.context.register(edited));
  }
  return doc.context.register(result);
}

// ---- Comentários e campos ----

/**
 * Tira um widget (campo de formulário) da árvore do formulário. O campo que
 * fica sem nenhum widget sai também; devolve os campos que saíram.
 */
function detachWidget(doc, ref, widget) {
  const { context } = doc;
  const acroForm = doc.catalog.lookup(key("AcroForm"));
  const fields = acroForm instanceof PDFDict ? acroForm.lookup(key("Fields")) : null;
  const order = acroForm instanceof PDFDict ? acroForm.lookup(key("CO")) : null;
  const same = (a, b) => a === b || context.lookup(a) === context.lookup(b);
  const without = (array, target) => {
    if (!(array instanceof PDFArray)) return;
    for (let i = array.size() - 1; i >= 0; i--) if (same(array.get(i), target)) array.remove(i);
  };
  const gone = [];
  let child = ref;
  let node = widget;
  for (let depth = 0; depth < 10; depth++) {
    const parentRef = node.get(key("Parent"));
    const parent = parentRef ? context.lookup(parentRef) : null;
    without(order, child);
    if (!(parent instanceof PDFDict)) {
      without(fields, child);
      return gone;
    }
    const kids = parent.lookup(key("Kids"));
    without(kids, child);
    if (kids instanceof PDFArray && kids.size() > 0) return gone;
    // O campo ficou sem widgets: sai também, com o valor que tinha.
    if (parentRef instanceof PDFRef) gone.push(parentRef);
    child = parentRef;
    node = parent;
  }
  return gone;
}

/**
 * Tira da página as anotações (comentários, links, campos) que tocam as áreas
 * (todas, sem `rects`), com as notas e respostas delas; devolve quantas. Os
 * objetos ficam vazios: a estrutura de acessibilidade ainda pode apontar para eles.
 */
export function removeAnnotations(doc, page, rects = null) {
  const { context } = doc;
  const annots = page.node.lookup(key("Annots"));
  if (!(annots instanceof PDFArray)) return 0;
  const items = annots.asArray().map((ref) => ({ ref, annot: context.lookup(ref) }));
  const gone = new Set();
  for (const { annot } of items) {
    if (!(annot instanceof PDFDict)) continue;
    if (rects) {
      const rect = numbers(annot.lookup(key("Rect")));
      if (!rect || rect.length !== 4 || rect.some((v) => !Number.isFinite(v))) continue;
      const box = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      if (!rects.some((r) => overlaps(r, box))) continue;
    }
    gone.add(annot);
  }
  if (!gone.size) return 0;
  const count = gone.size;
  // Notas (popup) e respostas de um comentário que saiu vão junto.
  for (let changed = true; changed; ) {
    changed = false;
    for (const { annot } of items) {
      if (!(annot instanceof PDFDict) || gone.has(annot)) continue;
      if (gone.has(annot.lookup(key("Parent"))) || gone.has(annot.lookup(key("IRT")))) {
        gone.add(annot);
        changed = true;
      }
    }
  }
  const keep = items.filter(({ annot }) => !gone.has(annot)).map(({ ref }) => ref);
  if (keep.length) page.node.set(key("Annots"), context.obj(keep));
  else page.node.delete(key("Annots"));
  const empty = new Set();
  for (const { ref, annot } of items) {
    if (!gone.has(annot) || !(ref instanceof PDFRef)) continue;
    if (nameOf(annot.lookup(key("Subtype"))) === "Widget") detachWidget(doc, ref, annot).forEach((field) => empty.add(field));
    const popup = annot.get(key("Popup"));
    if (popup instanceof PDFRef) empty.add(popup);
    empty.add(ref);
  }
  for (const ref of empty) context.assign(ref, context.obj({}));
  return count;
}

// ---- A página ----

/**
 * Tarja a página: `rects` são as áreas [x0, y0, x1, y1] em coordenadas da
 * página. `editJpeg(bytes, boxes, width, height)` (do navegador) devolve
 * { bytes, width, height } do JPEG com as caixas pintadas de preto, ou null.
 * Devolve o que saiu e se a página precisa virar imagem para garantir.
 */
export async function redactPage(doc, page, rects, { editJpeg = null } = {}) {
  const report = { glyphs: 0, images: 0, annotations: 0, raster: false };
  const copies = pageCopies(doc, page);
  const text = redactText(doc, page, rects, { copies });
  report.glyphs = text.removed;
  if (text.unsure) report.raster = true;

  // Imagens: as caixas cobertas de cada uma, todas as vezes que ela aparece.
  const edits = new Map();
  for (const image of imagePlacements(doc, page)) {
    const covering = rects.filter((r) => overlaps(r, image.rect));
    if (!covering.length) continue;
    const width = image.stream && num(image.stream.dict.lookup(key("Width")));
    const height = image.stream && num(image.stream.dict.lookup(key("Height")));
    const boxes = !image.inline && !image.repeated && width && height ? pixelBoxes(image.ctm, width, height, covering) : null;
    if (!boxes) {
      report.raster = true;
      continue;
    }
    const id = `${pathOf(image.scope)}/${image.name}`;
    if (!edits.has(id)) edits.set(id, { image, boxes: [] });
    edits.get(id).boxes.push(...boxes);
  }
  for (const { image, boxes } of edits.values()) {
    const ref = await redactImage(doc, image.stream, boxes, editJpeg);
    if (!ref) {
      report.raster = true;
      continue;
    }
    // Só esta página (e a cópia dos formulários dela) passa a usar a imagem tarjada.
    copies.resourcesOf(image.scope).lookup(key("XObject"), PDFDict).set(key(image.name), ref);
    report.images++;
  }

  report.annotations = removeAnnotations(doc, page, rects);
  // A miniatura guardada e os dados de outros programas mostrariam o que foi tarjado.
  page.node.delete(key("Thumb"));
  page.node.delete(key("PieceInfo"));

  // As tarjas pretas por cima de tudo.
  isolatePage(doc, page);
  for (const [x0, y0, x1, y1] of rects) page.drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, color: rgb(0, 0, 0) });
  return report;
}

/**
 * Troca o conteúdo da página por uma imagem dela (JPEG já tarjado, com a área
 * visível `view` [x0, y0, x1, y1]): nada do conteúdo antigo fica no arquivo.
 */
export function replaceWithImage(doc, page, image, view) {
  const [x0, y0, x1, y1] = view;
  const content = `q ${x1 - x0} 0 0 ${y1 - y0} ${x0} ${y0} cm /Tarja Do Q`;
  page.node.set(key("Contents"), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
  page.node.set(key("Resources"), doc.context.obj({ XObject: { Tarja: image.ref } }));
  page.node.delete(key("Thumb"));
  page.node.delete(key("PieceInfo"));
}

/**
 * Tira os dados do documento (título, autor, assunto, palavras-chave, programa
 * de origem e o XMP) e os dados particulares de outros programas.
 */
export function cleanMetadata(doc) {
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const name of info.keys()) if (!["CreationDate", "ModDate"].includes(name.decodeText())) info.delete(name);
  }
  doc.catalog.delete(key("Metadata"));
  doc.catalog.delete(key("PieceInfo"));
  for (const page of doc.getPages()) {
    page.node.delete(key("Metadata"));
    page.node.delete(key("PieceInfo"));
  }
}

/**
 * Tira do arquivo os objetos que nada mais usa. O pdf-lib grava todos ao
 * salvar, e entre eles estariam o conteúdo antigo das páginas tarjadas e as
 * imagens originais.
 */
export function dropUnreachable(doc) {
  const { context } = doc;
  const seen = new Set();
  const stack = Object.values(context.trailerInfo).filter(Boolean);
  while (stack.length) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      if (seen.has(obj)) continue;
      seen.add(obj);
      const target = context.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFStream) stack.push(obj.dict);
    else if (obj instanceof PDFDict) for (const [, value] of obj.entries()) stack.push(value);
    else if (obj instanceof PDFArray) stack.push(...obj.asArray());
  }
  let dropped = 0;
  for (const [ref] of [...context.enumerateIndirectObjects()]) {
    if (seen.has(ref)) continue;
    context.delete(ref);
    dropped++;
  }
  return dropped;
}

// ---- Procurar o que tarjar ----

/** Dígitos verificadores do CPF. */
export function cpfValid(digits) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(digits[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

/** Dígitos verificadores do CNPJ, também do novo, com letras (cada letra vale o código menos 48). */
export function cnpjValid(value) {
  if (!/^[\dA-Z]{12}\d{2}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const check = (n) => {
    const weights = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += (value.charCodeAt(i) - 48) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return check(12) === Number(value[12]) && check(13) === Number(value[13]);
}

/**
 * Dados pessoais que dá para marcar de uma vez. Um número sem pontuação só
 * conta como CPF ou CNPJ com os dígitos verificadores certos.
 */
export const PATTERNS = {
  cpf: {
    label: "CPF",
    regex: /(?<![\d.])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\d])/g,
    accept: (m) => /[.-]/.test(m) || cpfValid(m),
  },
  cnpj: {
    label: "CNPJ",
    regex: /(?<![\dA-Z.])[\dA-Z]{2}\.?[\dA-Z]{3}\.?[\dA-Z]{3}\/?[\dA-Z]{4}-?\d{2}(?![\dA-Z])/g,
    accept: (m) => (/^[\d./-]+$/.test(m) && /[./-]/.test(m)) || cnpjValid(m.replace(/[./-]/g, "")),
  },
  email: { label: "e-mail", regex: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu },
  phone: { label: "telefone", regex: /(?<![\d-])(?:\+?55\s?)?(?:\(\d{2}\)\s?|\d{2}\s)?(?:9\s?)?\d{4}[-\s.]\d{4}(?![\d-])/g },
  cep: { label: "CEP", regex: /(?<![\d.-])\d{2}\.?\d{3}-\d{3}(?![\d-])/g },
  date: { label: "data", regex: /(?<![\d/.-])(?:0?[1-9]|[12]\d|3[01])([/.-])(?:0?[1-9]|1[0-2])\1(?:\d{4}|\d{2})(?![\d/.-])/g },
};

/** Texto sem acentos e em minúsculas, e de que caractere do original veio cada um. */
function plainWithMap(text) {
  let plain = "";
  const from = [];
  for (let i = 0; i < text.length; i++) {
    const piece = text[i].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    for (const ch of piece) {
      plain += ch;
      from.push(i);
    }
  }
  from.push(text.length);
  return { plain, from };
}

const WORD = /[\p{L}\p{N}]/u;

/** Trechos [início, fim) do texto (sem diferenciar maiúsculas e acentos). */
export function termHits(text, term, whole = true) {
  const words = plainWithMap(term.trim()).plain.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const regex = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
  const { plain, from } = plainWithMap(text);
  const hits = [];
  for (const m of plain.matchAll(regex)) {
    const end = m.index + m[0].length;
    if (whole && ((m.index > 0 && WORD.test(plain[m.index - 1]) && WORD.test(m[0][0])) || (end < plain.length && WORD.test(plain[end]) && WORD.test(m[0].at(-1))))) continue;
    hits.push([from[m.index], from[end - 1] + 1]);
  }
  return hits;
}

/** Trechos [início, fim) com o dado pessoal `pattern` (uma chave de PATTERNS). */
export function patternHits(text, pattern) {
  const { regex, accept } = PATTERNS[pattern];
  const hits = [];
  for (const m of text.matchAll(regex)) if (!accept || accept(m[0])) hits.push([m.index, m.index + m[0].length]);
  return hits;
}

/**
 * Áreas [x0, y0, x1, y1] das ocorrências nas linhas da página (de textLines):
 * de um texto ou de um dado pessoal. No texto invisível do OCR, o que se vê é
 * a imagem por baixo, que nunca coincide letra por letra: a área ganha uma folga.
 */
export function findMatches(lines, { term = "", whole = true, pattern = null } = {}) {
  const rects = [];
  for (const line of lines) {
    const hits = pattern ? patternHits(line.text, pattern) : termHits(line.text, term, whole);
    for (const [a, b] of hits) {
      const boxes = line.boxes.slice(a, b).filter(Boolean);
      if (!boxes.length) continue;
      const rect = [Math.min(...boxes.map((r) => r[0])), Math.min(...boxes.map((r) => r[1])), Math.max(...boxes.map((r) => r[2])), Math.max(...boxes.map((r) => r[3]))];
      if (line.hidden?.slice(a, b).some(Boolean)) {
        const h = Math.min(rect[3] - rect[1], rect[2] - rect[0]);
        rect[0] -= 0.2 * h;
        rect[2] += 0.2 * h;
        rect[1] -= 0.1 * h;
        rect[3] += 0.1 * h;
      }
      rects.push(rect);
    }
  }
  return rects;
}
