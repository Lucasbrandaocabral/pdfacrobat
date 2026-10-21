// Texto na página: editar uma linha que já existe e escrever texto novo, com
// as fontes do catálogo ou com a própria fonte do PDF (quando ela tem as
// letras). O texto antigo é apagado do conteúdo da página; quando não dá para
// separá-lo com segurança, é coberto com a cor do fundo.
import {
  PDFHexString,
  PDFName,
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
import { baseFontName, decoderFor, findTextRuns, fontEncoder, hiddenRuns, lineRuns, removeRuns } from "./textops.js";

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

/** Diferença entre dois ângulos, em radianos (de 0 a π). */
const angleGap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/**
 * Linhas editáveis a partir dos pedaços de texto do PDF.js (getTextItems).
 * Pedaços na mesma linha de base, da mesma fonte e do mesmo tamanho, perto um
 * do outro (até uma letra de distância), formam a linha: há PDFs que desenham
 * cada palavra separada, às vezes alternando entre cópias da mesma fonte
 * (`fontKey` dá o nome dela sem o prefixo de subconjunto, para contarem como
 * uma). Trechos de outra fonte e texto mais longe (células de tabela, colunas)
 * ficam à parte, para a edição não mexer no vizinho. O texto com espaçamento
 * entre letras, que o PDF.js quebra em palavras ("C L I Q U E" + "A Q U I"),
 * também volta a formar a linha.
 */
export function groupLines(items, { fontKey = (name) => name } = {}) {
  const entries = [];
  for (const item of items) {
    if (!item.str.trim() || !(item.size > 0) || !Number.isFinite(item.width)) continue;
    const collapsed = collapseLetters(item.str);
    const cos = Math.cos(item.angle);
    const sin = Math.sin(item.angle);
    entries.push({
      item,
      key: fontKey(item.fontName) || item.fontName,
      collapsed,
      spaced: Boolean(collapsed) && /\S \S/.test(item.str),
      // Posição da linha de base e ao longo dela (para ler de cima para baixo, da esquerda para a direita).
      across: -item.origin[0] * sin + item.origin[1] * cos,
      along: item.origin[0] * cos + item.origin[1] * sin,
    });
  }
  entries.sort((p, q) => Math.round(p.item.angle * 50) - Math.round(q.item.angle * 50) || q.across - p.across || p.along - q.along);
  const groups = [];
  for (const entry of entries) {
    const { item, key, collapsed, spaced } = entry;
    const cos = Math.cos(item.angle);
    const sin = Math.sin(item.angle);
    const fits = (g) => {
      if (g.key !== key || Math.abs(g.size - item.size) > 0.05 * g.size) return false;
      if (angleGap(g.angle, item.angle) > 0.02) return false;
      const dx = item.origin[0] - g.origin[0];
      const dy = item.origin[1] - g.origin[1];
      if (Math.abs(-dx * sin + dy * cos) > 0.2 * g.size) return false;
      const a = dx * cos + dy * sin;
      const b = a + item.width;
      // Sem sobrepor o que já está na linha.
      if (Math.min(b, g.to) - Math.max(a, g.from) >= 0.5 * Math.min(item.width, g.to - g.from)) return false;
      // Letras espaçadas: até uma letra e meia de distância; o resto, até uma letra.
      const reach = (collapsed && g.collapsible && (spaced || g.spaced) ? 1.5 : 1) * g.size;
      return a <= g.to + reach && b >= g.from - reach;
    };
    const group = groups.find(fits);
    if (!group) {
      groups.push({
        key,
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
    group.collapsible &&= Boolean(collapsed);
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
    const chars = new Map();
    for (const { item, a, collapsed } of parts) {
      const text = letterSpaced ? collapsed : item.str;
      if (end !== null && a - end > 0.12 * group.size && !/\s$/.test(str) && !/^\s/.test(text)) str += " ";
      str += text;
      end = a + item.width;
      chars.set(item.fontName, (chars.get(item.fontName) || 0) + item.str.length);
    }
    const rects = parts.map(({ item }) => item.rect);
    // As fontes do PDF.js da linha (cópias da mesma fonte), a mais usada primeiro.
    const fontNames = [...chars].sort((p, q) => q[1] - p[1]).map(([name]) => name);
    return {
      str: str.trim(),
      items: parts.map((p) => p.item),
      fontName: fontNames[0],
      fontNames,
      fontKey: group.key,
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

// ---- Parágrafos ----

const sameColor = (a, b) => (!a && !b) || (a && b && a.every((v, i) => Math.abs(v - b[i]) < 0.02));

/**
 * Parágrafos: linhas seguidas da mesma fonte, tamanho, cor e direção, com a
 * mesma distância entre elas e alinhadas (à esquerda, à direita, ao centro ou
 * justificadas), sem outro texto entre elas nem no meio delas (uma palavra em
 * negrito, por exemplo: aí as linhas ficam separadas, para a edição não
 * misturar as fontes), formam um bloco, editado de uma vez como no Acrobat.
 * Linhas estreitas (colunas de valores de uma tabela) não viram parágrafo.
 *
 * Cada bloco: `lines` (de cima para baixo), `align` ("left", "right",
 * "center" ou "justify"), `leading` (distância entre as linhas de base, em
 * pontos), `left` e `width` (a faixa do texto, ao longo da linha), `indent`
 * (recuo da primeira linha), `origin` (início da faixa na linha de base da
 * primeira linha, em coordenadas do PDF), `text` (as linhas que continuam na
 * de baixo viram espaço; as que terminam antes da margem, quebra de linha),
 * `rect`, `size`, `angle` e `single` (bloco de uma linha só).
 */
export function groupParagraphs(lines) {
  const frameOf = (line, angle = line.angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const from = line.origin[0] * cos + line.origin[1] * sin;
    return { from, to: from + line.width, y: -line.origin[0] * sin + line.origin[1] * cos };
  };
  const sorted = lines
    .map((line) => ({ line, ...frameOf(line) }))
    .sort((p, q) => Math.round(p.line.angle * 50) - Math.round(q.line.angle * 50) || q.y - p.y || p.from - q.from);
  // Pode juntar-se a outras: texto achado no conteúdo, sem letras espaçadas.
  const joinable = (line) => Boolean(line.runs) && !line.letterSpaced;
  const blocks = [];
  for (const entry of sorted) {
    const { line } = entry;
    const size = line.size;
    const tol = 0.6 * size;
    const joins = (block) => {
      const first = block.lines[0];
      if (!block.joinable || !joinable(line)) return false;
      if (first.fontKey !== line.fontKey || Math.abs(first.size - size) > 0.05 * first.size || angleGap(first.angle, line.angle) > 0.02) return false;
      if (!sameColor(first.color, line.color)) return false;
      const frames = block.lines.map((l) => frameOf(l, first.angle));
      const me = frameOf(line, first.angle);
      const last = frames[frames.length - 1];
      const gap = last.y - me.y;
      if (gap < 0.9 * size || gap > 2.2 * size) return false;
      if (frames.length >= 2 && Math.abs(gap - (frames[0].y - frames[1].y)) > 0.15 * size) return false;
      if (Math.min(last.to, me.to) - Math.max(last.from, me.from) < 0.3 * Math.min(last.to - last.from, me.to - me.from)) return false;
      // Alinhamentos que continuam possíveis com esta linha.
      const lefts = frames.slice(1).map((f) => f.from);
      const left = lefts.length ? Math.min(...lefts) : null;
      const align = new Set(block.align);
      if (align.has("left")) {
        const ok = left === null ? Math.abs(me.from - frames[0].from) <= tol || (me.from < frames[0].from && frames[0].from - me.from <= 4 * size) : Math.abs(me.from - left) <= tol;
        if (!ok) align.delete("left");
      }
      if (align.has("right") && Math.abs(me.to - last.to) > tol) align.delete("right");
      if (align.has("center") && Math.abs((me.from + me.to) / 2 - (last.from + last.to) / 2) > tol) align.delete("center");
      if (!align.size) return false;
      // Nada entre as linhas nem no meio delas (outra fonte, outro texto).
      const span = [Math.min(me.from, ...frames.map((f) => f.from)) - 0.1 * size, Math.max(me.to, ...frames.map((f) => f.to)) + 0.1 * size];
      const members = new Set([...block.lines, line]);
      for (const other of lines) {
        if (members.has(other) || angleGap(other.angle, first.angle) > 0.02) continue;
        const f = frameOf(other, first.angle);
        if (f.to <= span[0] || f.from >= span[1]) continue;
        if (f.y < last.y + 0.3 * size && f.y > me.y - 0.3 * size) return false;
        if (frames.some((g) => Math.abs(g.y - f.y) < 0.3 * size)) return false;
      }
      block.align = [...align];
      return true;
    };
    const block = blocks.find(joins);
    if (block) block.lines.push(line);
    else blocks.push({ lines: [line], joinable: joinable(line), align: ["left", "right", "center"] });
  }
  return blocks.flatMap((block) => {
    // Faixa estreita demais para ser um parágrafo (valores de uma tabela): cada linha fica sozinha.
    if (block.lines.length > 1) {
      const frames = block.lines.map((l) => frameOf(l, block.lines[0].angle));
      const width = Math.max(...frames.map((f) => f.to)) - Math.min(...frames.map((f) => f.from));
      if (width < 10 * block.lines[0].size) return block.lines.map((line) => describeBlock([line], ["left"]));
    }
    return [describeBlock(block.lines, block.align)];
  });

  function describeBlock(blockLines, aligns) {
    const first = blockLines[0];
    const size = first.size;
    const angle = first.angle;
    const frames = blockLines.map((l) => frameOf(l, angle));
    const rects = blockLines.map((l) => l.rect);
    const rect = [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
    const textOf = (l) => l.text || l.str;
    if (blockLines.length === 1) {
      return { lines: blockLines, single: true, align: "left", leading: null, left: frames[0].from, width: first.width, indent: 0, origin: first.origin, text: textOf(first), rect, size, angle };
    }
    const right = Math.max(...frames.map((f) => f.to));
    const nonLast = frames.slice(0, -1);
    let align = aligns.includes("left") ? "left" : aligns.includes("right") ? "right" : aligns.includes("center") ? "center" : "left";
    // Justificado: as linhas (menos a última) terminam todas na margem direita.
    if (align === "left" && nonLast.length >= 2 && nonLast.every((f) => right - f.to <= 0.15 * size)) align = "justify";
    const leftEdge = align === "left" || align === "justify" ? Math.min(...frames.slice(1).map((f) => f.from)) : Math.min(...frames.map((f) => f.from));
    const left = Math.min(leftEdge, frames[0].from);
    const indent = (align === "left" || align === "justify") && frames[0].from - leftEdge > 0.6 * size ? frames[0].from - leftEdge : 0;
    const width = right - left;
    const gaps = frames.slice(1).map((f, i) => frames[i].y - f.y).sort((a, b) => a - b);
    const leading = gaps[Math.floor(gaps.length / 2)];
    // A linha termina antes da margem por vontade (quebra de linha) ou porque a
    // próxima palavra não cabia (o texto continua na linha de baixo)?
    const soft = blockLines.slice(1).map((next, k) => {
      const nextText = textOf(next);
      const word = nextText.split(/\s/)[0] || "";
      const wordWidth = (next.width * word.length) / Math.max(1, nextText.length);
      const lead = k === 0 ? indent : 0;
      const used = frames[k].to - (align === "left" || align === "justify" ? left + lead : frames[k].from);
      return width - lead - used < wordWidth + 0.35 * size;
    });
    // Tantas linhas terminando antes da margem quanto continuando (ou mais): é
    // uma lista, cada linha fica na sua (o texto novo ainda quebra na largura).
    const list = soft.filter((s) => !s).length >= soft.filter(Boolean).length;
    let text = textOf(first);
    blockLines.slice(1).forEach((next, k) => {
      text += soft[k] && !list ? (/-$/.test(text) ? "" : " ") + textOf(next) : `\n${textOf(next)}`;
    });
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const y = frames[0].y;
    const origin = [left * cos - y * sin, left * sin + y * cos];
    return { lines: blockLines, single: false, align, leading, left, width, indent, origin, text, rect, size, angle };
  }
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
  if (line.letterSpaced) {
    text = "";
    let end = null;
    for (const run of sorted) {
      const decode = decoderFor(doc, run.fontDict);
      const chars = decode ? run.codes.map(decode) : [undefined];
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
    original: originalOf(doc, found),
    spacing: Number.isFinite(spacing) ? Math.max(-line.size / 2, Math.min(line.size, spacing)) : 0,
    text,
  };
}

// ---- Escrever ----

const subsetTag = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");

/**
 * Pedaços seguidos do texto escritos com a mesma fonte: a primeira das fontes
 * originais (`fonts`) que tem a letra ou, se nenhuma tiver, a do catálogo. O
 * espaço que nenhuma fonte original tem (PDFs que posicionam cada palavra, sem
 * desenhar os espaços) vira só um avanço ("gap"). Com `splitSpaces`, cada
 * espaço fica num pedaço próprio (linha justificada).
 */
function segmentsOf(text, fonts = [], splitSpaces = false) {
  const out = [];
  for (const char of text) {
    let font = -1;
    let code;
    for (let i = 0; i < fonts.length && font < 0; i++) {
      code = fonts[i].encoder.codeOf.get(char);
      if (code !== undefined) font = i;
    }
    const kind = font >= 0 ? "original" : char === " " && fonts.length ? "gap" : "catalog";
    const space = char === " " && (splitSpaces || kind === "gap");
    const last = out[out.length - 1];
    if (last && !space && !last.space && last.kind === kind && last.font === font) {
      last.text += char;
      if (kind === "original") last.codes.push(code);
    } else {
      out.push({ kind, font, text: char, codes: kind === "original" ? [code] : null, space });
    }
  }
  return out;
}

/**
 * Escreve as linhas `rows` ({ text, justify }) a partir de `origin` (linha de
 * base da primeira, em coordenadas do PDF), girado `angle` radianos, cada uma
 * `leading` pontos abaixo da anterior. `align` ("left", "center" ou "right") e
 * `width` posicionam cada linha na faixa; numa linha com `justify`, o espaço
 * que sobra é dividido entre os espaços dela. `indent` recua a primeira linha.
 * `style`: tamanho, cor [r, g, b] de 0 a 1, negrito, itálico e espaçamento
 * entre letras (pt). `catalog`: bytes e nome da fonte do catálogo e se o
 * negrito é de verdade. `original`: as fontes do PDF ({ fonts: [{ ref, dict,
 * encoder }] }) a usar no que elas tiverem; o resto sai com a do catálogo.
 */
async function writeText(doc, page, { origin, angle, rows, style, catalog, original, leading, align = "left", width = 0, indent = 0 }) {
  const { size, spacing = 0 } = style;
  const step = leading ?? LINE_HEIGHT * size;
  const fonts = original?.fonts ?? [];
  const pieces = rows.map((row) => segmentsOf(row.text.normalize("NFC"), fonts, row.justify));
  let catalogFont = null;
  let catalogKey = null;
  let gapWidth = 0.278 * size;
  const needsCatalog = pieces.some((line) => line.some((s) => s.kind === "catalog"));
  const hasGaps = pieces.some((line) => line.some((s) => s.kind === "gap"));
  if (needsCatalog || (hasGaps && catalog)) {
    // O leitor de fontes é grande: só carrega quando for usar uma fonte do catálogo.
    const { default: fontkit } = await import("@cantoo/fontkit");
    if (needsCatalog) {
      doc.registerFontkit(fontkit);
      // Completando a fonte original, a do catálogo leva o nome dela: na próxima
      // edição, o texto continua sendo visto como um só (as letras de cada uma).
      const name = original?.name || catalog.name;
      catalogFont = await doc.embedFont(catalog.bytes, { subset: true, customName: `${subsetTag()}+${name}` });
      catalogKey = page.node.newFontDictionary(catalogFont.name, catalogFont.ref);
      gapWidth = catalogFont.widthOfTextAtSize(" ", size);
    } else {
      // Só para a largura do espaço: a fonte do catálogo parecida com a original.
      const font = fontkit.create(catalog.bytes);
      const glyph = font.glyphForCodePoint(32);
      if (glyph && font.unitsPerEm) gapWidth = (glyph.advanceWidth / font.unitsPerEm) * size;
    }
  }
  const originalKeys = new Map();
  const originalKey = (index) => {
    if (!originalKeys.has(index)) {
      const { ref, dict } = fonts[index];
      originalKeys.set(index, page.node.newFontDictionary("Orig", ref instanceof PDFRef ? ref : doc.context.register(dict)));
    }
    return originalKeys.get(index);
  };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const color = rgb(...style.color);
  const fakeBold = style.bold && !catalog?.bold;
  const ops = [pushGraphicsState(), setFillingColor(color)];
  if (fakeBold) ops.push(setStrokingColor(color), setLineWidth(boldStroke(size)));
  ops.push(beginText(), setCharacterSpacing(spacing));
  pieces.forEach((segments, i) => {
    const prepared = segments.map((segment) => {
      if (segment.kind === "gap") return { segment, key: null, hex: null, advance: (gapWidth + spacing) * segment.text.length };
      if (segment.kind === "original") {
        const { encoder } = fonts[segment.font];
        const digits = encoder.twoByte ? 4 : 2;
        return {
          segment,
          key: originalKey(segment.font),
          hex: PDFHexString.of(segment.codes.map((c) => c.toString(16).padStart(digits, "0")).join("")),
          advance: segment.codes.reduce((sum, c) => sum + encoder.width(c) * size + spacing, 0),
        };
      }
      const hex = catalogFont.encodeText(segment.text);
      const count = hex.asString().replace(/[<>\s]/g, "").length / 4;
      return { segment, key: catalogKey, hex, advance: catalogFont.widthOfTextAtSize(segment.text, size) + spacing * count };
    });
    const lead = i === 0 ? indent : 0;
    const natural = prepared.reduce((sum, p) => sum + p.advance, 0);
    const free = width - lead - natural;
    const spaces = rows[i].justify ? segments.filter((s) => s.space).length : 0;
    const extra = spaces && free > 0 ? free / spaces : 0;
    let x = lead + (align === "center" ? Math.max(0, free) / 2 : align === "right" ? Math.max(0, free) : 0);
    // Cada linha abaixo da anterior, na direção do texto.
    const base = [origin[0] + i * step * sin, origin[1] - i * step * cos];
    for (const { segment, key, hex, advance } of prepared) {
      if (!hex) {
        x += advance + (segment.space ? extra * segment.text.length : 0);
        continue;
      }
      let skew = 0;
      let mode = TextRenderingMode.Fill;
      if (segment.kind === "catalog") {
        if (style.italic) skew = ITALIC_SKEW;
        if (fakeBold) mode = TextRenderingMode.FillAndOutline;
      }
      const at = [base[0] + x * cos, base[1] + x * sin];
      const matrix = multiply([1, 0, skew, 1, 0, 0], [cos, sin, -sin, cos, at[0], at[1]]);
      ops.push(setFontAndSize(key, size), setTextRenderingMode(mode), setTextMatrix(...matrix), showText(hex));
      x += advance + (segment.space ? extra : 0);
    }
  });
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

/** Texto com quebras de linha (\n) nas linhas que writeText escreve. */
const rowsOf = (text) =>
  text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => ({ text: line, justify: false }));

/**
 * As fontes do PDF dos trechos `runs` que servem para escrever texto novo (as
 * cópias da mesma fonte, a mais usada primeiro), ou null se nenhuma servir.
 */
function originalOf(doc, runs) {
  const used = new Map();
  for (const run of runs || []) {
    if (!run.fontDict) continue;
    const entry = used.get(run.fontDict) || { ref: run.fontRef, dict: run.fontDict, glyphs: 0 };
    entry.glyphs += run.glyphs || 0;
    used.set(run.fontDict, entry);
  }
  const fonts = [...used.values()]
    .sort((a, b) => b.glyphs - a.glyphs)
    .map((f) => ({ ...f, encoder: fontEncoder(doc, f.dict) }))
    .filter((f) => f.encoder);
  if (!fonts.length) return null;
  const base = fonts[0].dict.lookup(PDFName.of("BaseFont"));
  return { fonts, name: base instanceof PDFName ? baseFontName(base.decodeText()) || null : null };
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
  if (text.trim()) await writeText(doc, page, { origin, angle: line.angle, rows: rowsOf(text), style, catalog, original });
  return Boolean(runs);
}

/**
 * Troca o texto de um parágrafo (de groupParagraphs) pelas linhas `rows`
 * ({ text, justify }), como ficaram na caixa de edição, no estilo `style` (veja
 * editText), a partir de `origin` (o começo da faixa do parágrafo na primeira
 * linha de base, se ele não foi movido), na largura `width` (a do parágrafo,
 * se ela não mudou). A distância entre as linhas acompanha o tamanho da
 * letra; o alinhamento é o do parágrafo.
 * Devolve se todo o texto antigo saiu do conteúdo.
 */
export async function editBlock(doc, pageIndex, { block, rows, style, catalog, bg, origin = block.origin, width = block.width }) {
  const page = doc.getPage(pageIndex);
  const all = findTextRuns(doc, page);
  const found = block.lines.map((line) => lineRuns(all, line));
  const runs = found.flatMap((r) => r || []);
  const original = style.font === "original" ? originalOf(doc, runs) : null;
  const hidden = block.lines.flatMap((line, i) => (found[i] ? [] : hiddenRuns(all, line)));
  if (runs.length || hidden.length) removeRuns(doc, page, [...runs, ...hidden]);
  isolatePage(doc, page);
  block.lines.forEach((line, i) => {
    if (!found[i]) cover(page, line, bg);
  });
  if (rows.some((row) => row.text.trim())) {
    await writeText(doc, page, {
      origin,
      angle: block.angle,
      rows,
      style,
      catalog,
      original,
      leading: (block.leading / block.size) * style.size,
      align: block.align === "justify" ? "left" : block.align,
      width,
      indent: block.indent,
    });
  }
  return found.every(Boolean);
}

/** Escreve texto novo na página (veja writeText). */
export async function addText(doc, pageIndex, { origin, angle = 0, text, style, catalog }) {
  const page = doc.getPage(pageIndex);
  isolatePage(doc, page);
  await writeText(doc, page, { origin, angle, rows: rowsOf(text), style, catalog, original: null });
}
