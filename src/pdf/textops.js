// Comandos de texto do conteúdo da página (Tj, TJ, ' e "), inclusive dentro de
// formulários (Form XObjects, comuns em PDFs do Canva): onde cada trecho começa
// e termina, com fonte, tamanho, espaçamento e cor. Permite apagar um trecho de
// verdade, trocando-o por um avanço vazio do mesmo tamanho: o texto some e o
// que vem depois continua no lugar.
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } from "@cantoo/pdf-lib";
import { Encodings, Font } from "@cantoo/pdf-lib/standard-fonts";
import { decodeStream, multiply, parseOperations, readPageContent, tokenize, transformPoint, writePageContent } from "./content.js";

const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_DEPTH = 6;
const encoder = new TextEncoder();
const SHOW = new Set(["Tj", "TJ", "'", '"']);
const STANDARD = {
  helvetica: "Helvetica",
  arial: "Helvetica",
  timesroman: "Times-Roman",
  times: "Times-Roman",
  courier: "Courier",
  symbol: "Symbol",
  zapfdingbats: "ZapfDingbats",
};

const num = (obj) => (typeof obj?.asNumber === "function" ? obj.asNumber() : undefined);
const nameOf = (obj) => (obj instanceof PDFName ? obj.decodeText() : "");
const key = (name) => PDFName.of(name);

// ---- Strings do conteúdo ----

function literalBytes(bytes, start, end) {
  const out = [];
  for (let i = start + 1; i < end - 1; i++) {
    const c = bytes[i];
    if (c !== 0x5c) {
      out.push(c);
      continue;
    }
    const n = bytes[++i];
    if (n === 0x6e) out.push(0x0a);
    else if (n === 0x72) out.push(0x0d);
    else if (n === 0x74) out.push(0x09);
    else if (n === 0x62) out.push(0x08);
    else if (n === 0x66) out.push(0x0c);
    else if (n === 0x0d) {
      if (bytes[i + 1] === 0x0a) i++;
    } else if (n === 0x0a) {
      // Continuação de linha: não vira caractere.
    } else if (n >= 0x30 && n <= 0x37) {
      let v = n - 0x30;
      for (let k = 0; k < 2 && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x37; k++) v = v * 8 + (bytes[++i] - 0x30);
      out.push(v & 0xff);
    } else {
      out.push(n);
    }
  }
  return out;
}

function hexBytes(bytes, start, end) {
  let digits = "";
  for (let i = start + 1; i < end - 1; i++) {
    const ch = String.fromCharCode(bytes[i]);
    if (/[0-9a-f]/i.test(ch)) digits += ch;
  }
  if (digits.length % 2) digits += "0";
  const out = [];
  for (let i = 0; i < digits.length; i += 2) out.push(parseInt(digits.slice(i, i + 2), 16));
  return out;
}

// ---- Fontes: larguras e codificação ----

let winAnsiNames = null;
function standardWidths(baseFont) {
  const name = baseFont.replace(/^[A-Z]{6}\+/, "");
  const lower = name.toLowerCase().replace(/[^a-z]/g, "");
  let fontName = Object.values(STANDARD).find((n) => n === name);
  if (!fontName) {
    const family = Object.keys(STANDARD).find((k) => lower.startsWith(k));
    if (!family) return null;
    const base = STANDARD[family];
    const bold = /bold/.test(lower);
    const italic = /italic|oblique/.test(lower);
    if (base === "Times-Roman") fontName = bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
    else if (base === "Symbol" || base === "ZapfDingbats") fontName = base;
    else fontName = `${base}${bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : ""}`;
  }
  let font;
  try {
    font = Font.load(fontName);
  } catch {
    return null;
  }
  if (!winAnsiNames) {
    winAnsiNames = new Map();
    for (const cp of Encodings.WinAnsi.supportedCodePoints) {
      const { code, name: glyph } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
      winAnsiNames.set(code, glyph);
    }
  }
  return (code) => (font.getWidthOfGlyph(winAnsiNames.get(code) || "space") || 0) / 1000;
}

function descendantOf(doc, dict) {
  const descendants = dict.lookup(key("DescendantFonts"));
  const cid = descendants instanceof PDFArray ? doc.context.lookup(descendants.get(0)) : null;
  return cid instanceof PDFDict ? cid : null;
}

/** Como ler os códigos de uma fonte e a largura de cada um (em unidades de texto). */
function fontMetrics(doc, dict) {
  const subtype = nameOf(dict.lookup(key("Subtype")));
  if (subtype === "Type0") {
    if (nameOf(dict.lookup(key("Encoding"))) !== "Identity-H") return null;
    const cid = descendantOf(doc, dict);
    if (!cid) return null;
    const dw = num(cid.lookup(key("DW"))) ?? 1000;
    const widths = new Map();
    const w = cid.lookup(key("W"));
    if (w instanceof PDFArray) {
      const items = w.asArray().map((x) => doc.context.lookup(x));
      for (let i = 0; i < items.length; ) {
        const first = num(items[i]);
        const next = items[i + 1];
        if (first === undefined) break;
        if (next instanceof PDFArray) {
          next.asArray().forEach((v, k) => widths.set(first + k, num(doc.context.lookup(v)) ?? dw));
          i += 2;
        } else {
          const last = num(next);
          const value = num(items[i + 2]) ?? dw;
          if (last === undefined || last - first > 0xffff) break;
          for (let c = first; c <= last; c++) widths.set(c, value);
          i += 3;
        }
      }
    }
    return { twoByte: true, width: (code) => (widths.get(code) ?? dw) / 1000 };
  }
  const widthsArray = dict.lookup(key("Widths"));
  if (!(widthsArray instanceof PDFArray)) {
    const standard = standardWidths(nameOf(dict.lookup(key("BaseFont"))));
    return standard ? { twoByte: false, width: standard } : null;
  }
  const first = num(dict.lookup(key("FirstChar"))) ?? 0;
  const descriptor = dict.lookup(key("FontDescriptor"));
  const missing = (descriptor instanceof PDFDict && num(descriptor.lookup(key("MissingWidth")))) || 0;
  const widths = widthsArray.asArray().map((x) => num(doc.context.lookup(x)) ?? 0);
  let scale = 1 / 1000;
  if (subtype === "Type3") {
    const matrix = dict.lookup(key("FontMatrix"));
    scale = (matrix instanceof PDFArray && num(doc.context.lookup(matrix.get(0)))) || 0.001;
  }
  return {
    twoByte: false,
    width: (code) => (code >= first && code < first + widths.length ? widths[code - first] : missing) * scale,
  };
}

const toInt = (bytes) => bytes.reduce((v, b) => v * 256 + b, 0);
function utf16(bytes) {
  const units = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) units.push((bytes[i] << 8) | bytes[i + 1]);
  return units;
}

/** Pares [código, texto] do mapa ToUnicode de uma fonte. */
function parseToUnicode(bytes) {
  const out = [];
  let mode = null;
  let args = [];
  let array = null;
  for (const t of tokenize(bytes)) {
    if (t.type === "op") {
      if (t.value === "beginbfchar" || t.value === "beginbfrange") {
        mode = t.value === "beginbfchar" ? "char" : "range";
        args = [];
      } else if (t.value === "endbfchar" || t.value === "endbfrange") {
        mode = null;
      }
      continue;
    }
    if (!mode) continue;
    if (t.type === "arrayStart") {
      array = [];
      continue;
    }
    if (t.type === "hex" || t.type === "name") {
      const value = t.type === "hex" ? hexBytes(bytes, t.start, t.end) : null;
      if (array) {
        array.push(value);
        continue;
      }
      args.push(value);
    } else if (t.type === "arrayEnd") {
      args.push({ list: array || [] });
      array = null;
    } else {
      continue;
    }
    if (mode === "char" && args.length === 2) {
      const [src, dst] = args;
      if (src && dst && !dst.list) out.push([toInt(src), String.fromCharCode(...utf16(dst))]);
      args = [];
    } else if (mode === "range" && args.length === 3) {
      const [lo, hi, dst] = args;
      const a = lo ? toInt(lo) : 0;
      const b = hi ? toInt(hi) : -1;
      if (dst && b >= a && b - a <= 0xffff) {
        // Destino em lista (um texto para cada código) ou inicial (incrementado a cada código).
        for (let code = a; code <= b; code++) {
          if (dst.list) {
            const item = dst.list[code - a];
            if (item) out.push([code, String.fromCharCode(...utf16(item))]);
          } else {
            const units = utf16(dst);
            if (!units.length) break;
            units[units.length - 1] += code - a;
            out.push([code, String.fromCharCode(...units)]);
          }
        }
      }
      args = [];
    }
  }
  return out;
}

const embedded = (descriptor) =>
  descriptor instanceof PDFDict && ["FontFile", "FontFile2", "FontFile3"].some((k) => descriptor.has(key(k)));

/**
 * Como escrever texto novo com uma fonte que já está no PDF: o código de cada
 * caractere que ela tem (`codeOf`) e a largura de cada código. Só para fontes
 * embutidas com o mapa de caracteres (ToUnicode) ou completas com a
 * codificação do Windows; null nos outros casos.
 */
const encoderCache = new WeakMap();
export function fontEncoder(doc, dict) {
  if (!(dict instanceof PDFDict)) return null;
  if (!encoderCache.has(dict)) encoderCache.set(dict, buildEncoder(doc, dict));
  return encoderCache.get(dict);
}

function buildEncoder(doc, dict) {
  if (nameOf(dict.lookup(key("Subtype"))) === "Type3") return null;
  const metrics = metricsFor(doc, dict);
  if (!metrics) return null;
  const descriptor = (metrics.twoByte ? descendantOf(doc, dict) : dict)?.lookup(key("FontDescriptor"));
  if (!embedded(descriptor)) return null;
  const limit = metrics.twoByte ? 0xffff : 0xff;
  const codeOf = new Map();
  const toUnicode = dict.lookup(key("ToUnicode"));
  if (toUnicode instanceof PDFStream) {
    let pairs = [];
    try {
      pairs = parseToUnicode(decodeStream(toUnicode));
    } catch {
      pairs = [];
    }
    for (const [code, text] of pairs) {
      const char = text.normalize("NFC");
      if (code <= limit && [...char].length === 1 && !codeOf.has(char)) codeOf.set(char, code);
    }
  } else if (
    !metrics.twoByte &&
    !/^[A-Z]{6}\+/.test(nameOf(dict.lookup(key("BaseFont")))) &&
    nameOf(dict.lookup(key("Encoding"))) === "WinAnsiEncoding"
  ) {
    // Fonte simples completa (não é um subconjunto) com a codificação do Windows.
    for (const cp of Encodings.WinAnsi.supportedCodePoints) {
      const { code } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
      if (metrics.width(code) > 0) codeOf.set(String.fromCodePoint(cp), code);
    }
  }
  if (!codeOf.size) return null;
  return { twoByte: metrics.twoByte, codeOf, width: metrics.width };
}

let winAnsiText = null;
let glyphText = null;
function standardTables() {
  if (!winAnsiText) {
    winAnsiText = new Map();
    glyphText = new Map();
    for (const cp of Encodings.WinAnsi.supportedCodePoints) {
      const { code, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
      winAnsiText.set(code, String.fromCodePoint(cp));
      glyphText.set(name, String.fromCodePoint(cp));
    }
  }
}

/** Texto de um nome de glifo ("aacute", "uni00E9"...), quando conhecido. */
function textOfGlyph(name) {
  standardTables();
  if (glyphText.has(name)) return glyphText.get(name);
  const uni = /^uni([0-9A-F]{4})$/.exec(name) || /^u([0-9A-F]{4,6})$/.exec(name);
  return uni ? String.fromCodePoint(parseInt(uni[1], 16)) : undefined;
}

/** Função código -> texto da fonte (pelo ToUnicode ou pela codificação), ou null. */
function buildDecoder(doc, dict) {
  const toUnicode = dict.lookup(key("ToUnicode"));
  if (toUnicode instanceof PDFStream) {
    try {
      const map = new Map(parseToUnicode(decodeStream(toUnicode)));
      return (code) => map.get(code);
    } catch {
      return null;
    }
  }
  const subtype = nameOf(dict.lookup(key("Subtype")));
  if (subtype === "Type0") return null;
  const base = nameOf(dict.lookup(key("BaseFont"))).replace(/^[A-Z]{6}\+/, "");
  if (/^(Symbol|ZapfDingbats)/.test(base)) return null;
  standardTables();
  const encoding = dict.lookup(key("Encoding"));
  const baseEncoding = encoding instanceof PDFDict ? nameOf(encoding.lookup(key("BaseEncoding"))) : nameOf(encoding);
  const differences = new Map();
  const list = encoding instanceof PDFDict ? encoding.lookup(key("Differences")) : null;
  if (list instanceof PDFArray) {
    let code = 0;
    for (const item of list.asArray().map((x) => doc.context.lookup(x))) {
      if (item instanceof PDFName) differences.set(code++, textOfGlyph(item.decodeText()));
      else if (num(item) !== undefined) code = num(item);
    }
  }
  return (code) => {
    if (differences.has(code)) return differences.get(code);
    if (baseEncoding === "WinAnsiEncoding") return winAnsiText.get(code);
    // Codificação padrão (ou nenhuma): o básico coincide com o ASCII.
    return code >= 32 && code < 127 ? String.fromCharCode(code) : undefined;
  };
}

const decoderCache = new WeakMap();
/** Texto de cada código da fonte (cache por fonte); null se não der para saber. */
export function decoderFor(doc, dict) {
  if (!(dict instanceof PDFDict)) return null;
  if (!decoderCache.has(dict)) decoderCache.set(dict, buildDecoder(doc, dict));
  return decoderCache.get(dict);
}

/**
 * Avanço do trecho (em unidades de texto), largura só dos caracteres, quantos
 * são e seus códigos, mais o avanço dos espaços no começo (`lead`) e no fim
 * (`trail`), que não aparecem.
 */
function measure(content, op, metrics, state, decode) {
  const bytes = content.subarray(op.start, op.end);
  let advance = 0;
  let natural = 0;
  let depth = 0;
  let lead = null;
  let inkEnd = 0;
  const codes = [];
  const blank = (code) => {
    const text = decode?.(code);
    return text === undefined ? !metrics.twoByte && code === 32 : !text.trim();
  };
  for (const token of tokenize(bytes)) {
    if (token.type === "arrayStart") depth++;
    else if (token.type === "arrayEnd") depth--;
    else if (token.type === "number" && depth > 0) {
      advance -= (token.value / 1000) * state.size * state.th;
    } else if (token.type === "string" || token.type === "hex") {
      const raw = token.type === "string" ? literalBytes(bytes, token.start, token.end) : hexBytes(bytes, token.start, token.end);
      const step = metrics.twoByte ? 2 : 1;
      for (let i = 0; i + step <= raw.length; i += step) {
        const code = step === 2 ? (raw[i] << 8) | raw[i + 1] : raw[i];
        const w0 = metrics.width(code);
        const wordSpace = step === 1 && code === 32 ? state.tw : 0;
        const visible = !blank(code);
        if (visible && lead === null) lead = advance;
        advance += (w0 * state.size + state.tc + wordSpace) * state.th;
        natural += w0 * state.size * state.th;
        if (visible) inkEnd = advance - state.tc * state.th;
        codes.push(code);
      }
    }
  }
  return { advance, natural, glyphs: codes.length, codes, lead: lead ?? advance, inkEnd: lead === null ? advance : inkEnd };
}

const metricsCache = new WeakMap();
function metricsFor(doc, dict) {
  if (!dict) return null;
  if (!metricsCache.has(dict)) {
    let metrics = null;
    try {
      metrics = fontMetrics(doc, dict);
    } catch {
      metrics = null;
    }
    metricsCache.set(dict, metrics);
  }
  return metricsCache.get(dict);
}

// ---- Cores ----

const cmykToRgb = ([c, m, y, k]) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];

/** Quantos componentes tem o espaço de cor (1 cinza, 3 RGB, 4 CMYK); 0 se não for um desses. */
function colorSpaceSize(resources, name) {
  const direct = { DeviceGray: 1, G: 1, DeviceRGB: 3, RGB: 3, DeviceCMYK: 4, CMYK: 4 }[name];
  if (direct) return direct;
  const spaces = resources?.lookup(key("ColorSpace"));
  const space = spaces instanceof PDFDict ? spaces.lookup(key(name)) : null;
  if (space instanceof PDFName) return colorSpaceSize(null, space.decodeText());
  if (!(space instanceof PDFArray)) return 0;
  const family = nameOf(space.lookup(0));
  if (family === "CalRGB") return 3;
  if (family === "CalGray") return 1;
  if (family === "ICCBased") {
    const n = num(space.lookup(1)?.dict?.lookup(key("N")));
    return [1, 3, 4].includes(n) ? n : 0;
  }
  return 0;
}

function toRgb(values, size) {
  if (size === 1 && values.length >= 1) return [values[0], values[0], values[0]];
  if (size === 3 && values.length >= 3) return values.slice(0, 3);
  if (size === 4 && values.length >= 4) return cmykToRgb(values);
  return null;
}

// ---- Leitura dos trechos ----

const numbers = (op) => op.operands.filter((t) => t.type === "number").map((t) => t.value);

/**
 * Trechos de texto desenhados na página, na ordem do conteúdo. `known` é falso
 * quando a posição depende de um trecho cuja largura não deu para calcular
 * (fonte sem as medidas). `scope` diz em que formulário o trecho está (null:
 * no conteúdo da própria página).
 */
export function findTextRuns(doc, page, content = readPageContent(doc, page)) {
  const runs = [];
  const state = {
    ctm: IDENTITY,
    font: null,
    fontDict: null,
    fontRef: null,
    size: 0,
    tc: 0,
    tw: 0,
    th: 1,
    tl: 0,
    rise: 0,
    mode: 0,
    fill: [0, 0, 0],
    space: 1,
  };
  scan(doc, content, page.node.Resources(), null, state, runs, 0);
  return runs;
}

function scan(doc, content, resources, scope, initial, runs, depth) {
  const fonts = resources?.lookup(key("Font"));
  const xobjects = resources?.lookup(key("XObject"));
  const ops = parseOperations(content);
  // Um formulário desenhado mais de uma vez no mesmo conteúdo (um logotipo
  // repetido, por exemplo) fica de fora: apagar texto nele apagaria em todos.
  const uses = new Map();
  for (const o of ops) {
    if (o.op === "Do" && o.operands[0]?.type === "name") uses.set(o.operands[0].value, (uses.get(o.operands[0].value) || 0) + 1);
  }
  const stack = [];
  let gs = { ...initial };
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let known = true;
  const nextLine = () => {
    tlm = multiply([1, 0, 0, 1, 0, -gs.tl], tlm);
    tm = tlm;
    known = true;
  };
  for (const o of ops) {
    const n = numbers(o);
    switch (o.op) {
      case "q":
        stack.push({ ...gs });
        break;
      case "Q":
        gs = stack.pop() || gs;
        break;
      case "cm":
        if (n.length === 6) gs.ctm = multiply(n, gs.ctm);
        break;
      case "BT":
        tm = tlm = IDENTITY;
        known = true;
        break;
      case "Tf": {
        const name = o.operands[0]?.type === "name" ? o.operands[0].value : null;
        const ref = fonts instanceof PDFDict && name ? fonts.get(key(name)) : null;
        const dict = ref ? doc.context.lookup(ref) : null;
        gs.font = name;
        gs.fontDict = dict instanceof PDFDict ? dict : null;
        gs.fontRef = ref instanceof PDFRef ? ref : null;
        gs.size = n[0] ?? 0;
        break;
      }
      case "Tc":
        gs.tc = n[0] ?? 0;
        break;
      case "Tw":
        gs.tw = n[0] ?? 0;
        break;
      case "Tz":
        gs.th = (n[0] ?? 100) / 100;
        break;
      case "TL":
        gs.tl = n[0] ?? 0;
        break;
      case "Ts":
        gs.rise = n[0] ?? 0;
        break;
      case "Tr":
        gs.mode = n[0] ?? 0;
        break;
      case "Td":
      case "TD":
        if (o.op === "TD") gs.tl = -(n[1] ?? 0);
        tlm = multiply([1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0], tlm);
        tm = tlm;
        known = true;
        break;
      case "Tm":
        if (n.length === 6) {
          tm = tlm = n;
          known = true;
        }
        break;
      case "T*":
        nextLine();
        break;
      case "g":
      case "rg":
      case "k":
        gs.space = { g: 1, rg: 3, k: 4 }[o.op];
        gs.fill = toRgb(n, gs.space);
        break;
      case "cs":
        gs.space = o.operands[0]?.type === "name" ? colorSpaceSize(resources, o.operands[0].value) : 0;
        gs.fill = gs.space ? toRgb([0, 0, 0, 1], gs.space) : null;
        break;
      case "sc":
      case "scn":
        gs.fill = o.operands.some((t) => t.type === "name") ? null : toRgb(n, gs.space);
        break;
      case "Do": {
        const name = o.operands[0]?.type === "name" ? o.operands[0].value : null;
        if (!name || depth >= MAX_DEPTH || uses.get(name) !== 1 || !(xobjects instanceof PDFDict)) break;
        const stream = xobjects.lookup(key(name));
        if (!(stream instanceof PDFStream) || nameOf(stream.dict.lookup(key("Subtype"))) !== "Form") break;
        let formContent;
        try {
          formContent = decodeStream(stream);
        } catch {
          break;
        }
        const matrix = stream.dict.lookup(key("Matrix"));
        const m = matrix instanceof PDFArray ? matrix.asArray().map((v) => num(doc.context.lookup(v))) : IDENTITY;
        const own = stream.dict.lookup(key("Resources"));
        const formResources = own instanceof PDFDict ? own : resources;
        const child = { name, stream, parent: scope, resources: formResources };
        const ctm = m.length === 6 && m.every(Number.isFinite) ? multiply(m, gs.ctm) : gs.ctm;
        scan(doc, formContent, formResources, child, { ...gs, ctm }, runs, depth + 1);
        break;
      }
      default:
        if (!SHOW.has(o.op)) break;
        if (o.op === '"') {
          gs.tw = n[0] ?? gs.tw;
          gs.tc = n[1] ?? gs.tc;
        }
        if (o.op === "'" || o.op === '"') nextLine();
        {
          const metrics = metricsFor(doc, gs.fontDict);
          const measured = metrics ? measure(content, o, metrics, gs, decoderFor(doc, gs.fontDict)) : null;
          const trm = multiply(tm, gs.ctm);
          runs.push({
            op: o.op,
            start: o.start,
            end: o.end,
            scope,
            known: known && Boolean(measured),
            origin: transformPoint(trm, 0, gs.rise),
            endPoint: measured ? transformPoint(trm, measured.advance, gs.rise) : null,
            // Onde começam e terminam as letras visíveis (sem os espaços das pontas).
            inkStart: measured ? transformPoint(trm, measured.lead, gs.rise) : null,
            inkEnd: measured ? transformPoint(trm, measured.inkEnd, gs.rise) : null,
            codes: measured?.codes ?? [],
            size: Math.abs(gs.size) * Math.hypot(trm[2], trm[3]),
            // Quantos pontos da página vale uma unidade de texto ao longo da linha.
            unit: Math.hypot(trm[0], trm[1]),
            fontSize: gs.size,
            font: gs.font,
            fontDict: gs.fontDict,
            fontRef: gs.fontRef,
            th: gs.th,
            tw: gs.tw,
            tc: gs.tc,
            mode: gs.mode,
            fill: gs.fill,
            advance: measured?.advance ?? 0,
            natural: measured?.natural ?? 0,
            glyphs: measured?.glyphs ?? 0,
          });
          if (measured) tm = multiply([1, 0, 0, 1, measured.advance, 0], tm);
          else known = false;
        }
    }
  }
}

/**
 * Os trechos que formam a linha `line` (origem, ângulo, largura e tamanho, em
 * coordenadas do PDF), ou null quando não dá para separá-los com segurança:
 * um trecho que avança para fora da linha levaria junto outro texto, e uma
 * linha só em parte encontrada deixaria pedaços do texto antigo.
 */
/** Medidas ao longo da linha e os trechos que começam nela (com o tamanho de letra dela). */
function nearLine(runs, line) {
  const cos = Math.cos(line.angle);
  const sin = Math.sin(line.angle);
  const along = ([x, y]) => (x - line.origin[0]) * cos + (y - line.origin[1]) * sin;
  const across = ([x, y]) => -(x - line.origin[0]) * sin + (y - line.origin[1]) * cos;
  const size = line.size;
  const candidates = runs.filter((run) => {
    if (run.known && (!run.glyphs || along(run.inkStart) === along(run.inkEnd))) return false;
    const start = run.inkStart || run.origin;
    const u0 = along(start);
    if (Math.abs(across(start)) > 0.35 * size || u0 < -0.5 * size || u0 > line.width + 0.25 * size) return false;
    return Math.abs(run.size - size) <= 0.3 * size;
  });
  return { along, candidates };
}

const invisible = (run) => run.mode === 3 || run.mode === 7;

/** Os trechos invisíveis (camada de OCR) da linha, que saem junto quando ela é coberta. */
export function hiddenRuns(runs, line) {
  return nearLine(runs, line).candidates.filter((run) => invisible(run) && run.known);
}

export function lineRuns(runs, line) {
  const size = line.size;
  const { along, candidates } = nearLine(runs, line);
  // Extensão das letras visíveis do trecho ao longo da linha.
  const span = (run) => {
    const a = along(run.inkStart);
    const b = along(run.inkEnd);
    return [Math.min(a, b), Math.max(a, b)];
  };
  if (!candidates.length) return null;
  // A linha é de uma fonte só; ao lado pode haver texto de outra (um rótulo em
  // negrito, por exemplo): fica a fonte que mais ocupa a linha.
  const weight = new Map();
  for (const run of candidates) {
    const [a, b] = run.known ? span(run) : [0, 0];
    const overlap = Math.max(0, Math.min(b, line.width) - Math.max(a, 0));
    weight.set(run.fontDict, (weight.get(run.fontDict) || 0) + overlap + 1e-3);
  }
  const font = [...weight].sort((a, b) => b[1] - a[1])[0][0];
  const picked = candidates.filter((run) => run.fontDict === font);
  if (picked.some((run) => !run.known)) return null;
  // Texto invisível (camada de OCR sobre uma imagem): o que se vê é a imagem.
  if (picked.some(invisible)) return null;
  const spans = picked.map(span).sort((p, q) => p[0] - q[0]);
  // Folga para pequenas diferenças entre as medidas do PDF.js e as daqui.
  const slack = Math.max(0.35 * size, 0.05 * line.width);
  if (spans.some(([from, to]) => to > line.width + slack + 0.25 * size || from < -slack - 0.25 * size)) return null;
  if (spans[0][0] > slack) return null;
  let reach = spans[0][1];
  for (const [from, to] of spans.slice(1)) {
    if (from - reach > 1.2 * size) return null;
    reach = Math.max(reach, to);
  }
  if (reach < line.width - slack) return null;
  return picked;
}

const fmt = (v) => String(Math.round(v * 1000) / 1000);

/** Conteúdo com os trechos `runs` trocados por avanços vazios do mesmo tamanho. */
export function blankRuns(content, runs) {
  const parts = [];
  let at = 0;
  for (const run of [...runs].sort((a, b) => a.start - b.start)) {
    parts.push(content.subarray(at, run.start));
    const unit = run.fontSize * run.th;
    const kern = unit ? `[${fmt((-run.advance * 1000) / unit)}] TJ` : "";
    let replacement = kern;
    if (run.op === "'") replacement = `T* ${kern}`;
    else if (run.op === '"') replacement = `${fmt(run.tw)} Tw ${fmt(run.tc)} Tc T* ${kern}`;
    parts.push(encoder.encode(` ${replacement} `));
    at = run.end;
  }
  parts.push(content.subarray(at));
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Stream novo (comprimido) com o conteúdo `bytes` e as demais entradas do dicionário `dict`. */
function restream(doc, dict, bytes) {
  const entries = {};
  for (const [name, value] of dict.entries()) {
    const k = name.decodeText();
    if (!["Length", "Filter", "DecodeParms"].includes(k)) entries[k] = value;
  }
  return doc.context.flateStream(bytes, entries);
}

/**
 * Apaga da página os trechos `runs` (de findTextRuns), onde quer que estejam.
 * Um formulário com texto apagado vira uma cópia só desta página: o mesmo
 * formulário pode aparecer em outras páginas, que continuam como estavam.
 */
export function removeRuns(doc, page, runs) {
  const { context } = doc;
  const copies = new Map();
  let pageResources = null;
  // Recursos próprios (copiados) de quem desenha o formulário, com a lista de XObjects também copiada.
  const ownResources = (holder, current) => {
    const resources = current instanceof PDFDict ? current.clone(context) : context.obj({});
    const xobjects = resources.lookup(key("XObject"));
    resources.set(key("XObject"), xobjects instanceof PDFDict ? xobjects.clone(context) : context.obj({}));
    holder.set(key("Resources"), resources);
    return resources;
  };
  const copyOf = (scope) => {
    if (!copies.has(scope)) {
      const stream = restream(doc, scope.stream.dict, decodeStream(scope.stream));
      const copy = { stream, ref: context.register(stream), resources: null };
      copies.set(scope, copy);
      resourcesOf(scope.parent).lookup(key("XObject"), PDFDict).set(key(scope.name), copy.ref);
    }
    return copies.get(scope);
  };
  const resourcesOf = (scope) => {
    if (!scope) return (pageResources ||= ownResources(page.node, page.node.Resources()));
    const copy = copyOf(scope);
    copy.resources ||= ownResources(copy.stream.dict, scope.resources);
    return copy.resources;
  };
  const groups = new Map();
  for (const run of runs) {
    if (!groups.has(run.scope)) groups.set(run.scope, []);
    groups.get(run.scope).push(run);
  }
  for (const [scope, list] of groups) {
    if (!scope) {
      writePageContent(doc, page, blankRuns(readPageContent(doc, page), list));
      continue;
    }
    const copy = copyOf(scope);
    const stream = restream(doc, copy.stream.dict, blankRuns(decodeStream(scope.stream), list));
    context.assign(copy.ref, stream);
    copy.stream = stream;
  }
}
