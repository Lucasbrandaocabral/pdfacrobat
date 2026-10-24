// Reparar PDF: refaz o arquivo a partir dos objetos que dá para ler, sem
// depender do índice (xref) nem do trailer — o que mais estraga num download
// interrompido ou num arquivo mexido. Acha o catálogo e as páginas (mesmo com
// a árvore de páginas quebrada), dá tamanho às páginas que não têm, tira
// referências a objetos que sumiram, recupera o começo dos conteúdos com a
// compressão danificada e descarta o que não é usado. O arquivo novo tem
// índice clássico, que qualquer leitor entende.
import {
  PDFArray,
  PDFCatalog,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFPageLeaf,
  PDFPageTree,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "@cantoo/pdf-lib";
import { parseOperations } from "./content.js";
import { dropUnreachable } from "./security.js";

const key = (name) => PDFName.of(name);
const num = (obj) => (typeof obj?.asNumber === "function" ? obj.asNumber() : undefined);
const A4 = [0, 0, 595.28, 841.89];
const INHERITABLE = ["Resources", "MediaBox", "CropBox", "Rotate"];
// Listas em que uma referência perdida simplesmente sai (nas outras vira null).
const LISTS = new Set(["Kids", "Annots", "Contents", "Fields", "CO", "Order", "ON", "OFF", "OCGs"]);
const encoder = new TextEncoder();

/**
 * Abre os bytes com o pdf-lib, que lê objeto por objeto. Sem o cabeçalho
 * "%PDF-", põe um na frente e tenta de novo.
 */
export async function loadDamaged(bytes, { password } = {}) {
  const options = { updateMetadata: false, throwOnInvalidObject: false };
  if (password !== undefined) options.password = password;
  let result;
  try {
    result = { doc: await PDFDocument.load(bytes, options), header: false };
  } catch (err) {
    if (!/header/i.test(err?.message)) throw err;
    const fixed = new Uint8Array(bytes.length + 9);
    fixed.set(encoder.encode("%PDF-1.7\n"), 0);
    fixed.set(bytes, 9);
    result = { doc: await PDFDocument.load(fixed, options), header: true };
  }
  // Arquivo cifrado que não foi decifrado (sem a senha, ou sem o trailer que diz
  // como decifrar): consertar daria um arquivo de lixo.
  const { context } = result.doc;
  const cipher = (obj) => obj instanceof PDFDict && obj.lookup(key("Filter")) === key("Standard") && obj.has(key("O")) && obj.has(key("U"));
  if (!context.isDecrypted && context.enumerateIndirectObjects().some(([, obj]) => cipher(obj))) {
    const error = new Error("encrypted document");
    error.name = "EncryptedPDFError";
    throw error;
  }
  return result;
}

const latin1 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return text;
};

/**
 * O índice do arquivo (xref) aponta para um índice de verdade? E o arquivo
 * termina com %%EOF, ou foi cortado?
 */
export function inspectBytes(bytes) {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const truncated = !/%%EOF\s*$/.test(tail.slice(-64)) && !tail.includes("%%EOF");
  const match = [...tail.matchAll(/startxref\s+(\d+)/g)].at(-1);
  if (!match) return { index: "missing", truncated };
  const offset = Number(match[1]);
  const head = latin1(bytes.subarray(offset, offset + 64));
  const ok = /^\s*xref/.test(head) || /^\s*\d+\s+\d+\s+obj/.test(head);
  return { index: ok ? "ok" : "broken", truncated };
}

/** Caixa [x0, y0, x1, y1] válida, ou null. */
function validBox(value) {
  if (!(value instanceof PDFArray) || value.size() !== 4) return null;
  const box = value.asArray().map((_, i) => num(value.lookup(i)));
  if (box.some((v) => !Number.isFinite(v))) return null;
  return Math.abs(box[2] - box[0]) > 1 && Math.abs(box[3] - box[1]) > 1 ? box : null;
}

/**
 * Páginas na ordem da árvore de páginas, com os atributos herdados, e os
 * buracos (referências a páginas que não existem) no lugar em que estavam.
 */
function pagesFromTree(doc, nodes = []) {
  const { context } = doc;
  const found = [];
  const seen = new Set();
  const pagesRef = doc.catalog instanceof PDFDict ? doc.catalog.get(key("Pages")) : null;
  const walk = (ref, node, inherited, depth) => {
    if (!(node instanceof PDFDict)) {
      // Página que sumiu do arquivo: fica o buraco.
      if (ref instanceof PDFRef) found.push({ hole: true });
      return;
    }
    if (seen.has(node) || depth > 64) return;
    seen.add(node);
    const type = node.lookup(key("Type"));
    const kids = node.lookup(key("Kids"));
    if (type === key("Page") || (!(kids instanceof PDFArray) && (node.has(key("Contents")) || node.has(key("MediaBox"))))) {
      found.push({ ref, node, inherited });
      return;
    }
    if (!(kids instanceof PDFArray)) return;
    if (ref instanceof PDFRef) nodes.push(ref);
    const next = { ...inherited };
    for (const name of INHERITABLE) if (node.has(key(name))) next[name] = node.get(key(name));
    for (let i = 0; i < kids.size(); i++) {
      const kidRef = kids.get(i);
      walk(kidRef, context.lookup(kidRef), next, depth + 1);
    }
  };
  if (pagesRef) walk(pagesRef, context.lookup(pagesRef), {}, 0);
  return found;
}

/** Objetos de página (dicionários com /Type /Page) em ordem de número. */
function pageObjects(doc) {
  return doc.context
    .enumerateIndirectObjects()
    .filter(([, obj]) => obj instanceof PDFDict && obj.lookup(key("Type")) === key("Page"))
    .sort(([a], [b]) => a.objectNumber - b.objectNumber || a.generationNumber - b.generationNumber)
    .map(([ref, node]) => ({ ref, node, inherited: {} }));
}

/**
 * Refaz o catálogo (se preciso) e a árvore de páginas, simples e com a
 * contagem certa. Buracos na árvore são preenchidos com as páginas órfãs
 * (que existem no arquivo mas ninguém aponta), na ordem dos números.
 */
function rebuildPageTree(doc, report) {
  const { context } = doc;
  // Catálogo estragado (sem /Type certo, por exemplo): vira um catálogo de novo.
  const rootRef = context.trailerInfo.Root;
  const root = context.lookup(rootRef);
  if (root instanceof PDFDict && !(root instanceof PDFCatalog) && root.has(key("Pages"))) {
    const catalog = PDFCatalog.fromMapWithContext(new Map(root.entries()), context);
    catalog.set(key("Type"), key("Catalog"));
    context.assign(rootRef, catalog);
    doc.catalog = catalog;
    report.catalog = true;
  }
  const oldNodes = [];
  let list = pagesFromTree(doc, oldNodes);
  const used = new Set(list.filter((p) => p.node).map((p) => p.node));
  const orphans = pageObjects(doc).filter((p) => !used.has(p.node));
  const holes = list.filter((p) => p.hole).length;
  if (!list.some((p) => p.node)) {
    // Sem árvore de páginas: todas as páginas que existem, na ordem dos números.
    list = pageObjects(doc);
    if (list.length) report.tree = true;
  } else if (holes) {
    let next = 0;
    list = list.flatMap((p) => (p.hole ? (next < orphans.length ? [orphans[next++]] : []) : [p]));
    report.tree = true;
    report.recovered += next;
    report.missing += holes - next;
  }
  list = list.filter((p) => p.node);
  if (!list.length) return [];

  const treeRef = context.nextRef();
  const refs = [];
  for (const page of list) {
    let { node, ref } = page;
    // Atributos herdados dos níveis de cima passam para a própria página.
    for (const [name, value] of Object.entries(page.inherited)) if (!node.has(key(name))) node.set(key(name), value);
    if (!(node instanceof PDFPageLeaf)) {
      node = PDFPageLeaf.fromMapWithContext(new Map(node.entries()), context);
      node.set(key("Type"), key("Page"));
    }
    if (!(ref instanceof PDFRef)) ref = context.register(node);
    else context.assign(ref, node);
    node.set(key("Parent"), treeRef);
    refs.push(ref);
  }
  const tree = PDFPageTree.fromMapWithContext(
    new Map([
      [key("Type"), key("Pages")],
      [key("Kids"), context.obj(refs)],
      [key("Count"), PDFNumber.of(refs.length)],
    ]),
    context,
  );
  context.assign(treeRef, tree);
  // Os nós da árvore antiga saem (não contam como lixo do arquivo original).
  for (const ref of oldNodes) context.delete(ref);
  if (!(doc.catalog instanceof PDFCatalog)) {
    const catalog = PDFCatalog.withContextAndPages(context, treeRef);
    context.trailerInfo.Root = context.register(catalog);
    doc.catalog = catalog;
    report.catalog = true;
  } else doc.catalog.set(key("Pages"), treeRef);
  doc.pageCache?.invalidate?.();
  return refs.map((ref) => context.lookup(ref));
}

/** O que dá para ler de um stream: os bytes inteiros, o começo (compressão danificada) ou null. */
function readStream(stream) {
  if (!(stream instanceof PDFRawStream)) return { bytes: stream.getContents?.() ?? new Uint8Array(), damaged: false };
  let decoder;
  try {
    decoder = decodePDFRawStream(stream);
  } catch (err) {
    // Filtro que não se conhece aqui (não é dano): fica como está.
    if (/not supported/i.test(err?.message)) return null;
    // Começo da compressão ilegível (cabeçalho errado, dados cifrados): nada se aproveita.
    return { bytes: new Uint8Array(), damaged: true };
  }
  try {
    return { bytes: decoder.decode(), damaged: false };
  } catch {
    // O decodificador guarda o que leu antes do trecho danificado.
    const partial = decoder.buffer && decoder.bufferLength ? decoder.buffer.subarray(0, decoder.bufferLength) : new Uint8Array();
    return { bytes: partial, damaged: true };
  }
}

const OPERATORS = new Set(
  "b B b* B* BDC BI BMC BT BX c cm CS cs d d0 d1 Do DP EI EMC ET EX f F f* G g gs h i ID j J K k l m M MP n q Q re RG rg ri s S SC sc SCN scn sh T* Tc Td TD Tf Tj TJ TL Tm Tr Ts Tw Tz v w W W* y ' \"".split(" "),
);

const isGarbage = (op) => !OPERATORS.has(op) && (op.length > 3 || /[^\x21-\x7e]/.test(op));

// Quantos valores cada comando leva (os de quantidade variável ficam de fora).
const ARGS = {
  Tf: 2, Td: 2, TD: 2, Tm: 6, cm: 6, Tj: 1, TJ: 1, "'": 1, '"': 3, re: 4, m: 2, l: 2, c: 6, v: 4, y: 4,
  g: 1, G: 1, rg: 3, RG: 3, k: 4, K: 4, w: 1, Tc: 1, Tw: 1, Tz: 1, TL: 1, Ts: 1, Tr: 1, Do: 1, gs: 1,
  cs: 1, CS: 1, q: 0, Q: 0, BT: 0, ET: 0, h: 0, f: 0, F: 0, "f*": 0, S: 0, s: 0, B: 0, "B*": 0, b: 0,
  "b*": 0, n: 0, W: 0, "W*": 0, EMC: 0, BDC: 2, BMC: 1, i: 1, M: 1, j: 1, J: 1, d: 2, ri: 1, sh: 1, "T*": 0,
};

/**
 * O conteúdo sem o lixo que um trecho danificado deixa: comandos que não
 * existem (compridos ou com bytes estranhos, fora de BX ... EX), comandos com
 * a quantidade errada de valores, Q e ET sem o q e o BT correspondentes; no
 * fim, fecha o texto e os estados que ficaram abertos. `changed`: se havia
 * algo a tirar.
 */
function cleanContent(bytes, ops = parseOperations(bytes), { page = false, resources = null } = {}) {
  // Nomes de fonte, imagem/formulário e estado gráfico que existem nos recursos.
  const has = (kind, operand) => {
    const dict = resources instanceof PDFDict ? resources.lookup(key(kind)) : null;
    return operand?.type === "name" && dict instanceof PDFDict && dict.has(key(operand.value));
  };
  const RESOURCE = { Tf: "Font", Do: "XObject", gs: "ExtGState" };
  const parts = [];
  let depth = 0;
  let inText = false;
  let compat = 0;
  let changed = false;
  // Fonte escolhida (faz parte do estado gráfico: volta com o Q).
  let font = false;
  const fonts = [];
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op === "BX") compat++;
    else if (o.op === "EX") compat = Math.max(0, compat - 1);
    // No conteúdo danificado, todo comando que não existe é lixo.
    const unknown = !OPERATORS.has(o.op);
    const shows = o.op === "Tj" || o.op === "TJ" || o.op === "'" || o.op === '"';
    const missing = o.op in RESOURCE && resources && !has(RESOURCE[o.op], o.operands[0]);
    if (!compat && (unknown || missing || (o.op in ARGS && o.operands.length !== ARGS[o.op]) || (page && shows && !font))) {
      if (o.op === "Tf") font = false;
      changed = true;
      continue;
    }
    if (o.op === "Tf") font = true;
    else if (o.op === "q") fonts.push(font);
    else if (o.op === "Q" && depth) font = fonts.pop() ?? font;
    if (o.op === "BI") {
      // Imagem embutida: vai inteira, com os dados entre ID e EI.
      const end = ops.findIndex((x, k) => k > i && x.op === "EI");
      if (end < 0) {
        changed = true;
        break;
      }
      parts.push(bytes.subarray(o.start, ops[end].end));
      i = end;
      continue;
    }
    if (o.op === "q") depth++;
    else if (o.op === "Q") {
      if (!depth) {
        changed = true;
        continue;
      }
      depth--;
    } else if (o.op === "BT") {
      if (inText) parts.push(encoder.encode("ET"));
      inText = true;
    } else if (o.op === "ET") {
      if (!inText) {
        changed = true;
        continue;
      }
      inText = false;
    }
    parts.push(bytes.subarray(o.start, o.end));
  }
  if (inText) parts.push(encoder.encode("ET"));
  for (; depth > 0; depth--) parts.push(encoder.encode("Q"));
  const newline = encoder.encode("\n");
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length + 1, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    out.set(newline, offset + part.length);
    offset += part.length + 1;
  }
  return { bytes: out, changed };
}

/**
 * Recupera um conteúdo (página, formulário, aparência) danificado, no mesmo
 * objeto. `page`: conteúdo da própria página (começa sem fonte escolhida).
 */
function salvageContent(doc, ref, report, page = false, pageResources = null) {
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFStream)) return;
  const read = readStream(stream);
  if (!read) return;
  // Só mexe no conteúdo com dano: a descompressão falhou ou apareceu lixo.
  const ops = parseOperations(read.bytes);
  if (!read.damaged && !ops.some((o) => isGarbage(o.op))) return;
  const own = stream.dict.lookup(key("Resources"));
  const resources = page ? pageResources : own instanceof PDFDict ? own : pageResources;
  const clean = cleanContent(read.bytes, ops, { page, resources: resources instanceof PDFDict ? resources : null });
  const entries = {};
  for (const [name, value] of stream.dict.entries()) {
    if (!["Length", "Filter", "DecodeParms", "DL"].includes(name.decodeText())) entries[name.decodeText()] = value;
  }
  doc.context.assign(ref, doc.context.flateStream(clean.bytes, entries));
  if (clean.bytes.length > 8) report.salvaged++;
  else report.lost++;
}

/** Conteúdos da página (true) e dos formulários e aparências que ela usa (false). */
function contentRefs(doc, page) {
  const { context } = doc;
  const refs = new Map();
  const contents = page.get(key("Contents"));
  if (contents instanceof PDFRef) refs.set(contents, true);
  const list = context.lookup(contents);
  if (list instanceof PDFArray) list.asArray().forEach((r) => r instanceof PDFRef && refs.set(r, true));
  const forms = (resources, depth) => {
    const xobjects = resources instanceof PDFDict ? resources.lookup(key("XObject")) : null;
    if (!(xobjects instanceof PDFDict) || depth > 6) return;
    for (const [, ref] of xobjects.entries()) {
      const stream = context.lookup(ref);
      if (!(ref instanceof PDFRef) || refs.has(ref) || !(stream instanceof PDFStream)) continue;
      if (stream.dict.lookup(key("Subtype")) !== key("Form")) continue;
      refs.set(ref, false);
      forms(stream.dict.lookup(key("Resources")), depth + 1);
    }
  };
  forms(page.lookup(key("Resources")), 0);
  const annots = page.lookup(key("Annots"));
  if (annots instanceof PDFArray) {
    for (let i = 0; i < annots.size(); i++) {
      const ap = annots.lookup(i)?.lookup?.(key("AP"));
      const normal = ap instanceof PDFDict ? ap.get(key("N")) : null;
      if (normal instanceof PDFRef && context.lookup(normal) instanceof PDFStream && !refs.has(normal)) refs.set(normal, false);
    }
  }
  return refs;
}

/** Tira as referências a objetos que não existem; devolve quantas. */
function dropBrokenLinks(doc) {
  const { context } = doc;
  const missing = (v) => v instanceof PDFRef && !context.lookup(v);
  let count = 0;
  const seen = new Set();
  const stack = [];
  for (const [name, value] of Object.entries(context.trailerInfo)) {
    if (missing(value)) {
      delete context.trailerInfo[name];
      count++;
    } else if (value) stack.push([value, name]);
  }
  while (stack.length) {
    const [obj, parentKey] = stack.pop();
    if (obj instanceof PDFRef) {
      if (seen.has(obj)) continue;
      seen.add(obj);
      const target = context.lookup(obj);
      if (target) stack.push([target, parentKey]);
    } else if (obj instanceof PDFStream) stack.push([obj.dict, parentKey]);
    else if (obj instanceof PDFDict) {
      for (const [name, value] of obj.entries()) {
        if (missing(value)) {
          obj.delete(name);
          count++;
        } else stack.push([value, name.decodeText()]);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = obj.size() - 1; i >= 0; i--) {
        const value = obj.get(i);
        if (!missing(value)) stack.push([value, parentKey]);
        else {
          if (LISTS.has(parentKey)) obj.remove(i);
          else obj.set(i, PDFNull);
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Conserta o documento no lugar. Devolve o relatório: catálogo e árvore de
 * páginas refeitos, páginas recuperadas, tamanhos dados, conteúdos
 * recuperados em parte ou perdidos, objetos ilegíveis, referências perdidas e
 * objetos sem uso descartados. `pages` 0: nada que dê para recuperar.
 */
export function repairDocument(doc) {
  const { context } = doc;
  const report = { pages: 0, catalog: false, tree: false, recovered: 0, missing: 0, sizes: 0, contents: 0, salvaged: 0, lost: 0, invalid: 0, links: 0, dropped: 0 };
  for (const [ref, obj] of [...context.enumerateIndirectObjects()]) {
    // Índices (XRef) e pacotes de objetos (ObjStm) do arquivo antigo: o arquivo novo tem os seus.
    // Num arquivo decifrado, o índice também aparece ilegível (o pdf-lib tenta decifrá-lo), e o
    // dicionário da cifra antiga fica sem uso: nenhum dos dois é dano.
    const type = obj instanceof PDFStream ? obj.dict.lookup(key("Type")) : null;
    const raw = obj instanceof PDFInvalidObject ? latin1((obj.data ?? new Uint8Array()).subarray(0, 512)) : "";
    const cipher = obj instanceof PDFDict && obj.lookup(key("Filter")) === key("Standard") && obj.has(key("O")) && obj.has(key("U"));
    if (type === key("XRef") || type === key("ObjStm") || /\/Type\s*\/XRef/.test(raw) || (cipher && context.isDecrypted)) context.delete(ref);
    else if (obj instanceof PDFInvalidObject) {
      context.delete(ref);
      report.invalid++;
    }
  }
  // Sem o trailer, os dados do documento (título, autor...) ficariam soltos: volta a apontar para eles.
  if (!(context.lookup(context.trailerInfo.Info) instanceof PDFDict)) {
    const info = context
      .enumerateIndirectObjects()
      .find(([, obj]) => obj instanceof PDFDict && !obj.has(key("Type")) && ["Producer", "Creator", "Title", "Author", "CreationDate", "ModDate"].some((name) => obj.has(key(name))));
    if (info) context.trailerInfo.Info = info[0];
  }
  const pages = rebuildPageTree(doc, report);
  report.pages = pages.length;
  if (!pages.length) return report;

  // Tamanho: o mais comum entre as páginas que têm; senão A4.
  const sizes = new Map();
  for (const page of pages) {
    const box = validBox(page.lookup(key("MediaBox")));
    if (box) sizes.set(box.join(" "), (sizes.get(box.join(" ")) || 0) + 1);
  }
  const common = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0].split(" ").map(Number) || A4;
  for (const page of pages) {
    if (!validBox(page.lookup(key("MediaBox")))) {
      page.set(key("MediaBox"), context.obj(common));
      report.sizes++;
    }
    if (page.has(key("CropBox")) && !validBox(page.lookup(key("CropBox")))) page.delete(key("CropBox"));
    const rotate = num(page.lookup(key("Rotate")));
    if (page.has(key("Rotate")) && !(Number.isInteger(rotate) && rotate % 90 === 0)) page.delete(key("Rotate"));
    if (!(page.lookup(key("Resources")) instanceof PDFDict)) page.set(key("Resources"), context.obj({}));
  }
  report.links = dropBrokenLinks(doc);
  for (const page of pages) {
    for (const [ref, own] of contentRefs(doc, page)) {
      report.contents++;
      salvageContent(doc, ref, report, own, page.lookup(key("Resources")));
    }
  }
  // Nenhum conteúdo legível: cifrado sem a senha ou danificado demais (o resultado seriam páginas em branco).
  report.unreadable = report.contents > 0 && report.lost === report.contents;
  report.dropped = dropUnreachable(doc);
  return report;
}

/** Frases do relatório para o usuário. */
export function describeRepair(report) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (report.truncated) parts.push("o arquivo estava incompleto (cortado no fim)");
  if (report.index && report.index !== "ok") parts.push(report.index === "missing" ? "índice do arquivo, que faltava, refeito" : "índice do arquivo, que estava errado, refeito");
  if (report.header) parts.push("cabeçalho refeito");
  if (report.catalog) parts.push("catálogo refeito");
  if (report.tree) parts.push(report.recovered ? `árvore de páginas refeita (${plural(report.recovered, "página perdida recuperada", "páginas perdidas recuperadas")})` : "árvore de páginas refeita");
  if (report.missing) parts.push(`${plural(report.missing, "página não pôde ser recuperada", "páginas não puderam ser recuperadas")} (não estão no arquivo)`);
  if (report.sizes) parts.push(`${plural(report.sizes, "página sem tamanho recebeu", "páginas sem tamanho receberam")} o tamanho das outras`);
  if (report.salvaged) parts.push(`${plural(report.salvaged, "conteúdo danificado recuperado", "conteúdos danificados recuperados")} até onde dava`);
  if (report.lost) parts.push(`${plural(report.lost, "conteúdo ilegível ficou", "conteúdos ilegíveis ficaram")} em branco`);
  if (report.invalid) parts.push(`${plural(report.invalid, "objeto ilegível descartado", "objetos ilegíveis descartados")}`);
  if (report.links) parts.push(`${plural(report.links, "referência a objeto perdido removida", "referências a objetos perdidos removidas")}`);
  if (report.dropped) parts.push(`${plural(report.dropped, "objeto sem uso descartado", "objetos sem uso descartados")}`);
  return parts;
}
