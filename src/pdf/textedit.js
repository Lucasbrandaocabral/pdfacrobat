// Texto na página: editar uma linha que já existe e escrever texto novo, com
// as fontes do catálogo ou com a própria fonte do PDF (quando ela tem as
// letras). O texto antigo é apagado do conteúdo da página; quando não dá para
// separá-lo com segurança, é coberto com a cor do fundo.
import {
  PDFHexString,
  PDFRef,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  radians,
  rgb,
  setCharacterSpacing,
  setFillingColor,
  setFontAndSize,
  setLineWidth,
  setStrokingColor,
  setTextMatrix,
  setTextRenderingMode,
  showText,
} from "@cantoo/pdf-lib";
import { isolatePage, multiply } from "./content.js";
import { decoderFor, findTextRuns, fontEncoder, hiddenRuns, lineRuns, removeRuns } from "./textops.js";

/** Altura de cada linha, em relação ao tamanho da letra (a mesma do editor na tela). */
export const LINE_HEIGHT = 1.2;
// Inclinação do itálico e espessura do negrito sintéticos: as mesmas do
// Chromium (Electron, Android), para o resultado ficar igual à prévia.
const ITALIC_SKEW = 0.25;
const boldStroke = (size) => size * (size <= 9 ? 1 / 24 : size >= 36 ? 1 / 32 : 1 / 24 + ((size - 9) / 27) * (1 / 32 - 1 / 24));

/** Família (sem serifa, com serifa ou monoespaçada), negrito e itálico pelo nome da fonte. */
export function fontStyle(fontFamily, realName = "") {
  const name = `${fontFamily} ${realName}`;
  const family = /mono|courier|consol/i.test(name) ? "mono" : /serif|times|georgia|garamond|cambria|book/i.test(name) && !/sans/i.test(name) ? "serif" : "sans";
  return {
    family,
    bold: /bold|black|heavy|semibold|demi/i.test(realName),
    italic: /italic|oblique/i.test(realName),
  };
}

/** Troca caracteres que uma fonte padrão do PDF (Helvetica...) não consegue escrever. */
export function encodable(text, font) {
  const supported = new Set(font.getCharacterSet());
  return [...text].map((ch) => (supported.has(ch.codePointAt(0)) ? ch : "?")).join("");
}

// ---- Linhas ----

const LETTER_SPACED = /^\S(?: \S)+$/u;

/** "C L I Q U E" (espaçamento entre letras visto pelo PDF.js como espaços) -> "CLIQUE"; null se não for o caso. */
function collapseLetters(str) {
  const words = str.trim().split(/\s{2,}/);
  if (!words.every((w) => LETTER_SPACED.test(w) || /^\S$/u.test(w))) return null;
  return words.map((w) => w.replace(/ /g, "")).join(" ");
}

/**
 * Linhas editáveis a partir dos pedaços de texto do PDF.js (getTextItems).
 * Cada pedaço é uma linha, como o PDF.js separou (células de tabela, colunas e
 * trechos de outra fonte ficam à parte, para a edição não mexer no vizinho),
 * exceto o texto com espaçamento entre letras, que o PDF.js quebra em palavras
 * ("C L I Q U E" + "A Q U I"): esses pedaços voltam a formar a linha.
 */
export function groupLines(items) {
  const groups = [];
  for (const item of items) {
    if (!item.str.trim() || !(item.size > 0) || !Number.isFinite(item.width)) continue;
    const collapsed = collapseLetters(item.str);
    const spaced = Boolean(collapsed) && /\S \S/.test(item.str);
    const cos = Math.cos(item.angle);
    const sin = Math.sin(item.angle);
    const fits = (g) => {
      if (!collapsed || !g.collapsible || !(spaced || g.spaced)) return false;
      if (g.fontName !== item.fontName || Math.abs(g.size - item.size) > 0.05 * g.size) return false;
      if (Math.abs(Math.atan2(Math.sin(g.angle - item.angle), Math.cos(g.angle - item.angle))) > 0.02) return false;
      const dx = item.origin[0] - g.origin[0];
      const dy = item.origin[1] - g.origin[1];
      if (Math.abs(-dx * sin + dy * cos) > 0.2 * g.size) return false;
      const a = dx * cos + dy * sin;
      const b = a + item.width;
      // Perto (até uma letra e meia de distância) e sem sobrepor.
      if (a > g.to + 1.5 * g.size || b < g.from - 1.5 * g.size) return false;
      return Math.min(b, g.to) - Math.max(a, g.from) < 0.5 * Math.min(item.width, g.to - g.from);
    };
    const group = groups.find(fits);
    if (!group) {
      groups.push({
        fontName: item.fontName,
        size: item.size,
        angle: item.angle,
        origin: item.origin,
        from: 0,
        to: item.width,
        collapsible: Boolean(collapsed),
        spaced,
        items: [{ item, a: 0, collapsed }],
      });
      continue;
    }
    const a = (item.origin[0] - group.origin[0]) * cos + (item.origin[1] - group.origin[1]) * sin;
    group.items.push({ item, a, collapsed });
    group.spaced ||= spaced;
    group.from = Math.min(group.from, a);
    group.to = Math.max(group.to, a + item.width);
  }
  return groups.map((group) => {
    const parts = group.items.sort((p, q) => p.a - q.a);
    const first = parts[0].item;
    const letterSpaced = group.collapsible && group.spaced;
    let str = "";
    let end = null;
    for (const { item, a, collapsed } of parts) {
      const text = letterSpaced ? collapsed : item.str;
      if (end !== null && a - end > 0.12 * group.size && !/\s$/.test(str) && !/^\s/.test(text)) str += " ";
      str += text;
      end = a + item.width;
    }
    const rects = parts.map(({ item }) => item.rect);
    return {
      str: str.trim(),
      items: parts.map((p) => p.item),
      fontName: group.fontName,
      fontFamily: first.fontFamily,
      size: group.size,
      angle: group.angle,
      origin: first.origin,
      width: group.to - group.from,
      ascent: first.ascent,
      descent: first.descent,
      letterSpaced,
      rect: [
        Math.min(...rects.map((r) => r[0])),
        Math.min(...rects.map((r) => r[1])),
        Math.max(...rects.map((r) => r[2])),
        Math.max(...rects.map((r) => r[3])),
      ],
    };
  });
}

/**
 * Como a linha está desenhada no conteúdo da página: os trechos (null se não
 * deu para achá-los), a cor do texto, a fonte original (null se ela não serve
 * para escrever texto novo), o espaçamento entre letras em pontos e, nas
 * linhas com letras espaçadas, o texto lido do próprio PDF (o PDF.js vê
 * "C L I Q U E" e pode perder o espaço entre as palavras).
 */
export function describeLine(doc, page, line, runs = findTextRuns(doc, page)) {
  const found = lineRuns(runs, line);
  if (!found) return { runs: null, color: null, original: null, spacing: null, text: null };
  const first = found[0];
  const sameColor = found.every((r) => r.fill && first.fill && r.fill.every((v, i) => Math.abs(v - first.fill[i]) < 0.01));
  const encoder = first.fontDict ? fontEncoder(doc, first.fontDict) : null;
  const cos = Math.cos(line.angle);
  const sin = Math.sin(line.angle);
  const along = ([x, y]) => (x - line.origin[0]) * cos + (y - line.origin[1]) * sin;
  const sorted = [...found].sort((a, b) => along(a.origin) - along(b.origin));
  let spacing = 0;
  if (found.every((r) => Math.abs(r.tc - first.tc) < 1e-6) && Math.abs(first.tc) > 1e-6) {
    // Espaçamento do próprio PDF (Tc), em pontos.
    spacing = first.tc * first.unit * first.th;
  } else if (line.letterSpaced) {
    if (sorted.length >= 3) {
      // Uma letra por trecho, cada uma posicionada: o espaço mais comum entre elas.
      const gaps = sorted.slice(1).map((run, i) => along(run.origin) - along(sorted[i].endPoint)).sort((a, b) => a - b);
      spacing = gaps[Math.floor(gaps.length / 2)];
    } else {
      const glyphs = found.reduce((sum, r) => sum + r.glyphs, 0);
      spacing = found.reduce((sum, r) => sum + (r.advance - r.natural) * r.unit, 0) / Math.max(1, glyphs);
    }
  }
  let text = null;
  const decode = line.letterSpaced ? decoderFor(doc, first.fontDict) : null;
  if (decode) {
    text = "";
    let end = null;
    for (const run of sorted) {
      const chars = run.codes.map(decode);
      if (chars.some((c) => c === undefined)) {
        text = null;
        break;
      }
      const part = chars.join("");
      if (end !== null && along(run.origin) - end > spacing + 0.2 * line.size && !/\s$/.test(text) && !/^\s/.test(part)) text += " ";
      text += part;
      end = along(run.endPoint);
    }
    text = text?.trim() || null;
  }
  return {
    runs: found,
    color: sameColor ? first.fill : null,
    original: encoder ? { codeOf: encoder.codeOf } : null,
    spacing: Number.isFinite(spacing) ? Math.max(-line.size / 2, Math.min(line.size, spacing)) : 0,
    text,
  };
}

// ---- Escrever ----

const subsetTag = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");

/** Pedaços seguidos do texto que a fonte original consegue escrever (ou não). */
function segmentsOf(text, encoder) {
  const out = [];
  for (const char of text) {
    const code = encoder?.codeOf.get(char);
    const kind = code === undefined ? "catalog" : "original";
    const last = out[out.length - 1];
    if (last?.kind === kind) {
      last.text += char;
      if (kind === "original") last.codes.push(code);
    } else {
      out.push({ kind, text: char, codes: kind === "original" ? [code] : null });
    }
  }
  return out;
}

/**
 * Escreve `text` (várias linhas separadas por \n) a partir de `origin` (linha
 * de base, em coordenadas do PDF), girado `angle` radianos. `style`: tamanho,
 * cor [r, g, b] de 0 a 1, negrito, itálico e espaçamento entre letras (pt).
 * `catalog`: bytes e nome da fonte do catálogo e se o negrito é de verdade.
 * `original`: a fonte do PDF (ref do dicionário e codificação) a usar no que
 * ela tiver; o resto sai com a do catálogo.
 */
async function writeText(doc, page, { origin, angle, text, style, catalog, original }) {
  const { size, spacing = 0 } = style;
  const lines = text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n");
  const pieces = lines.map((line) => segmentsOf(line, original?.encoder));
  let catalogFont = null;
  let catalogKey = null;
  if (pieces.some((line) => line.some((s) => s.kind === "catalog"))) {
    // O leitor de fontes é grande: só carrega quando for escrever com uma fonte do catálogo.
    const { default: fontkit } = await import("@cantoo/fontkit");
    doc.registerFontkit(fontkit);
    catalogFont = await doc.embedFont(catalog.bytes, { subset: true, customName: `${subsetTag()}+${catalog.name}` });
    catalogKey = page.node.newFontDictionary(catalogFont.name, catalogFont.ref);
  }
  let originalKey = null;
  if (original) {
    const ref = original.ref instanceof PDFRef ? original.ref : doc.context.register(original.dict);
    originalKey = page.node.newFontDictionary("Orig", ref);
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const color = rgb(...style.color);
  const fakeBold = style.bold && !catalog?.bold;
  const ops = [pushGraphicsState(), setFillingColor(color)];
  if (fakeBold) ops.push(setStrokingColor(color), setLineWidth(boldStroke(size)));
  ops.push(beginText(), setCharacterSpacing(spacing));
  pieces.forEach((segments, i) => {
    // Cada linha abaixo da anterior, na direção do texto.
    const base = [origin[0] + i * LINE_HEIGHT * size * sin, origin[1] - i * LINE_HEIGHT * size * cos];
    let x = 0;
    for (const segment of segments) {
      let hex;
      let advance;
      let skew = 0;
      let mode = TextRenderingMode.Fill;
      if (segment.kind === "original") {
        const digits = original.encoder.twoByte ? 4 : 2;
        hex = PDFHexString.of(segment.codes.map((c) => c.toString(16).padStart(digits, "0")).join(""));
        advance = segment.codes.reduce((sum, c) => sum + original.encoder.width(c) * size + spacing, 0);
        ops.push(setFontAndSize(originalKey, size));
      } else {
        hex = catalogFont.encodeText(segment.text);
        const count = hex.asString().replace(/[<>\s]/g, "").length / 4;
        advance = catalogFont.widthOfTextAtSize(segment.text, size) + spacing * count;
        if (style.italic) skew = ITALIC_SKEW;
        if (fakeBold) mode = TextRenderingMode.FillAndOutline;
        ops.push(setFontAndSize(catalogKey, size));
      }
      const at = [base[0] + x * cos, base[1] + x * sin];
      const matrix = multiply([1, 0, skew, 1, 0, 0], [cos, sin, -sin, cos, at[0], at[1]]);
      ops.push(setTextRenderingMode(mode), setTextMatrix(...matrix), showText(hex));
      x += advance;
    }
  });
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

/** A fonte do PDF dos trechos `runs`, para escrever com ela (null se não servir). */
function originalOf(doc, runs) {
  const run = runs?.[0];
  if (!run?.fontDict) return null;
  const encoder = fontEncoder(doc, run.fontDict);
  return encoder ? { ref: run.fontRef, dict: run.fontDict, encoder } : null;
}

/** Cobre a linha com a cor do fundo (quando o texto não pôde ser apagado do conteúdo). */
function cover(page, line, bg) {
  const pad = Math.max(0.6, line.size * 0.06);
  const ascent = Number.isFinite(line.ascent) ? line.ascent : 0.8;
  const descent = Number.isFinite(line.descent) ? line.descent : -0.2;
  const cos = Math.cos(line.angle);
  const sin = Math.sin(line.angle);
  const dy = descent * line.size - pad;
  page.drawRectangle({
    x: line.origin[0] - pad * cos - dy * sin,
    y: line.origin[1] - pad * sin + dy * cos,
    width: line.width + 2 * pad,
    height: (ascent - descent) * line.size + 2 * pad,
    rotate: radians(line.angle),
    color: rgb(...(bg || [1, 1, 1])),
  });
}

/**
 * Troca o texto de uma linha (de groupLines) por `text` no estilo `style`
 * (veja writeText; `style.font === "original"` usa a fonte do PDF no que ela
 * tiver), escrito a partir de `origin` (o lugar da linha, se ela não foi
 * movida). `bg` é a cor do fundo, usada se o texto antigo tiver de ser
 * coberto. Texto vazio só apaga a linha. Devolve se o texto antigo saiu do
 * conteúdo.
 */
export async function editText(doc, pageIndex, { line, text, style, catalog, bg, origin = line.origin }) {
  const page = doc.getPage(pageIndex);
  const all = findTextRuns(doc, page);
  const runs = lineRuns(all, line);
  const original = style.font === "original" ? originalOf(doc, runs) : null;
  // Sem os trechos visíveis (texto numa imagem escaneada), cobre a linha e tira o texto invisível do OCR.
  const removed = runs || hiddenRuns(all, line);
  if (removed.length) removeRuns(doc, page, removed);
  isolatePage(doc, page);
  if (!runs) cover(page, line, bg);
  if (text.trim()) await writeText(doc, page, { origin, angle: line.angle, text, style, catalog, original });
  return Boolean(runs);
}

/** Escreve texto novo na página (veja writeText). */
export async function addText(doc, pageIndex, { origin, angle = 0, text, style, catalog }) {
  const page = doc.getPage(pageIndex);
  isolatePage(doc, page);
  await writeText(doc, page, { origin, angle, text, style, catalog, original: null });
}

