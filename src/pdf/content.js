// Leitura do "content stream" das páginas (os comandos de desenho do PDF):
// localiza imagens e permite remover ou reposicionar uma ocorrência específica.
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  popGraphicsState,
  pushGraphicsState,
} from "@cantoo/pdf-lib";

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const IDENTITY = [1, 0, 0, 1, 0, 0];
const isRegular = (c) => !WHITESPACE.has(c) && !DELIMITERS.has(c);
const latin1 = (bytes) => String.fromCharCode(...bytes);
const encoder = new TextEncoder();

function decodeName(bytes) {
  return latin1(bytes).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Gera os tokens com posição (start/end) nos bytes. */
export function* tokenize(bytes) {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (WHITESPACE.has(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    const start = i;
    if (c === 0x2f) {
      i++;
      while (i < n && isRegular(bytes[i])) i++;
      yield { type: "name", value: decodeName(bytes.subarray(start + 1, i)), start, end: i };
      continue;
    }
    if (c === 0x28) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = bytes[i];
        if (ch === 0x5c) {
          i += 2;
          continue;
        }
        if (ch === 0x28) depth++;
        else if (ch === 0x29) depth--;
        i++;
      }
      yield { type: "string", start, end: i };
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        i += 2;
        yield { type: "dictStart", start, end: i };
        continue;
      }
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
      yield { type: "hex", start, end: i };
      continue;
    }
    if (c === 0x3e) {
      i += bytes[i + 1] === 0x3e ? 2 : 1;
      yield { type: "dictEnd", start, end: i };
      continue;
    }
    if (c === 0x5b || c === 0x5d) {
      i++;
      yield { type: c === 0x5b ? "arrayStart" : "arrayEnd", start, end: i };
      continue;
    }
    if (c === 0x7b || c === 0x7d || c === 0x29) {
      i++;
      continue;
    }
    while (i < n && isRegular(bytes[i])) i++;
    const word = latin1(bytes.subarray(start, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      yield { type: "number", value: parseFloat(word), start, end: i };
    } else if (word === "true" || word === "false" || word === "null") {
      yield { type: "literal", value: word, start, end: i };
    } else {
      yield { type: "op", value: word, start, end: i };
      if (word === "ID") {
        // Dados binários de imagem embutida: vão até " EI ".
        i++;
        while (i < n) {
          if (
            bytes[i] === 0x45 &&
            bytes[i + 1] === 0x49 &&
            WHITESPACE.has(bytes[i - 1]) &&
            (i + 2 >= n || WHITESPACE.has(bytes[i + 2]) || DELIMITERS.has(bytes[i + 2]))
          ) {
            break;
          }
          i++;
        }
        yield { type: "op", value: "EI", start: i, end: Math.min(i + 2, n) };
        i += 2;
      }
    }
  }
}

/** Agrupa tokens em operações: { op, operands, start, end }. */
export function parseOperations(bytes) {
  const ops = [];
  let operands = [];
  let start = null;
  let depth = 0;
  for (const token of tokenize(bytes)) {
    if (start === null) start = token.start;
    if (token.type === "arrayStart" || token.type === "dictStart") {
      if (depth === 0) operands.push({ type: token.type === "arrayStart" ? "array" : "dict" });
      depth++;
    } else if (token.type === "arrayEnd" || token.type === "dictEnd") {
      depth = Math.max(0, depth - 1);
    } else if (token.type === "op" && depth === 0) {
      ops.push({ op: token.value, operands, start, end: token.end });
      operands = [];
      start = null;
    } else if (depth === 0) {
      operands.push(token);
    }
  }
  return ops;
}

export function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function transformPoint([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Caixa [x0, y0, x1, y1] do quadrado unitário transformado pela matriz. */
export function unitBox(m) {
  const pts = [transformPoint(m, 0, 0), transformPoint(m, 1, 0), transformPoint(m, 0, 1), transformPoint(m, 1, 1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Bytes decodificados (sem compressão) de um stream do PDF. */
export function decodeStream(stream) {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (typeof stream?.getUnencodedContents === "function") return stream.getUnencodedContents();
  if (typeof stream?.getContents === "function") return stream.getContents();
  return new Uint8Array();
}

/** Conteúdo da página decodificado e concatenado. */
export function readPageContent(doc, page) {
  const contents = page.node.Contents();
  if (!contents) return new Uint8Array();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const parts = streams.map(decodeStream);
  const total = parts.reduce((sum, p) => sum + p.length + 1, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    out[offset + part.length] = 0x0a;
    offset += part.length + 1;
  }
  return out;
}

export function writePageContent(doc, page, bytes) {
  const ref = doc.context.register(doc.context.flateStream(bytes));
  page.node.set(PDFName.of("Contents"), ref);
}

/** Quantos "q" ficam sem "Q" correspondente no fim do conteúdo. */
export function openStateDepth(bytes) {
  let depth = 0;
  for (const { op } of parseOperations(bytes)) {
    if (op === "q") depth++;
    else if (op === "Q") depth = Math.max(0, depth - 1);
  }
  return depth;
}

const isolated = new WeakSet();

/**
 * Isola o conteúdo existente da página em q/Q antes de desenhar por cima, para
 * que transformações deixadas pelo autor do PDF não desloquem o novo desenho.
 */
export function isolatePage(doc, page) {
  if (isolated.has(page.node)) return;
  isolated.add(page.node);
  if (!page.node.Contents()) return;
  const depth = openStateDepth(readPageContent(doc, page));
  const start = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
  const end = doc.context.register(
    doc.context.contentStream(Array.from({ length: depth + 1 }, () => popGraphicsState())),
  );
  page.node.wrapContentStreams(start, end);
}

function xobjectSubtype(doc, page, name) {
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return null;
  const stream = xobjects.lookup(PDFName.of(name));
  return stream?.dict?.lookup(PDFName.of("Subtype"))?.asString?.() ?? null;
}

/** A imagem `name` da página tem transparência (máscara)? */
export function imageHasMask(doc, page, name) {
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return false;
  const dict = xobjects.lookup(PDFName.of(name))?.dict;
  if (!dict) return false;
  return dict.has(PDFName.of("SMask")) || dict.has(PDFName.of("Mask")) || dict.lookup(PDFName.of("ImageMask"))?.asBoolean?.() === true;
}

/** Imagens desenhadas diretamente na página, com posição e trecho no conteúdo. */
export function findImages(doc, page, content = readPageContent(doc, page)) {
  const ops = parseOperations(content);
  const stack = [];
  let ctm = IDENTITY;
  const images = [];
  const kinds = new Map();
  for (const o of ops) {
    if (o.op === "q") stack.push(ctm);
    else if (o.op === "Q") ctm = stack.pop() || IDENTITY;
    else if (o.op === "cm") {
      const nums = o.operands.map((t) => t.value);
      if (nums.length === 6 && nums.every((v) => typeof v === "number")) ctm = multiply(nums, ctm);
    } else if (o.op === "Do") {
      const name = o.operands[0]?.type === "name" ? o.operands[0].value : null;
      if (!name) continue;
      if (!kinds.has(name)) kinds.set(name, xobjectSubtype(doc, page, name));
      if (kinds.get(name) === "/Image") {
        images.push({ index: images.length, name, ctm, rect: unitBox(ctm), start: o.start, end: o.end });
      }
    }
  }
  return images;
}

function blankRange(content, start, end) {
  const out = content.slice();
  out.fill(0x20, start, end);
  return out;
}

/** Remove a ocorrência `index` de imagem da página. */
export function removeImage(doc, page, index) {
  const content = readPageContent(doc, page);
  const image = findImages(doc, page, content)[index];
  if (!image) return null;
  writePageContent(doc, page, blankRange(content, image.start, image.end));
  return image;
}

/** Move/redimensiona uma imagem para o retângulo `rect` [x0, y0, x1, y1]. */
export function moveImage(doc, page, index, rect) {
  const content = readPageContent(doc, page);
  const image = findImages(doc, page, content)[index];
  if (!image) return null;
  const [ox0, oy0, ox1, oy1] = image.rect;
  const [nx0, ny0, nx1, ny1] = rect;
  const sx = (nx1 - nx0) / (ox1 - ox0 || 1);
  const sy = (ny1 - ny0) / (oy1 - oy0 || 1);
  const ctm = multiply(image.ctm, [sx, 0, 0, sy, nx0 - ox0 * sx, ny0 - oy0 * sy]);
  const blanked = blankRange(content, image.start, image.end);
  const depth = openStateDepth(blanked);
  const fmt = (v) => (Math.round(v * 10000) / 10000).toString();
  const tail = encoder.encode(
    `\n${"Q\n".repeat(depth)}Q\nq ${ctm.map(fmt).join(" ")} cm /${image.name} Do Q\n`,
  );
  const out = new Uint8Array(2 + blanked.length + tail.length);
  out.set(encoder.encode("q\n"), 0);
  out.set(blanked, 2);
  out.set(tail, 2 + blanked.length);
  writePageContent(doc, page, out);
  return image;
}
