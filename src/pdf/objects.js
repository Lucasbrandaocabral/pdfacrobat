// Objetos da página, como no "Editar texto e imagens" do Acrobat: cada trecho
// de texto, imagem, desenho (linhas, retângulos, curvas), degradê e grupo
// repetido (formulário desenhado mais de uma vez), inclusive dentro de
// formulários desenhados uma vez só (comuns em PDFs do Canva).
//
// Mover apaga o original onde ele está (o resto da página não se mexe) e
// desenha por cima uma cópia exata, deslocada: os mesmos comandos, com o estado
// em que o original era desenhado (fonte, cores, espessura, transparência,
// recorte e camada). Duplicar é o mesmo sem apagar. Copiar leva os objetos, só
// com o que eles usam, para um PDF pequeno, que colar desenha em qualquer
// página, deste ou de outro documento.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObjectCopier, PDFRawStream, PDFRef, PDFStream } from "@cantoo/pdf-lib";
import { decodeStream, invert, isolatePage, multiply, parseOperations, readPageContent, tokenize, transformPoint, unitBox } from "./content.js";
import { FORM_BUDGET, MAX_DEPTH, blankReplacement, findTextRuns, glyphBoxes, pageCopies, rewriteContent } from "./textops.js";

const IDENTITY = [1, 0, 0, 1, 0, 0];
const key = (name) => PDFName.of(name);
const encoder = new TextEncoder();
const PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const FILL_ONLY = new Set(["f", "F", "f*"]);
const SHOW = new Set(["Tj", "TJ", "'", '"']);
// Espaços de cor que não são recursos da página.
const DEVICE_SPACES = new Set(["DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern", "G", "RGB", "CMYK", "I", "Indexed"]);

const fmt = (v) => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? "0" : String(r);
};
const isIdentity = (m) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
const pathOf = (scope) => (scope ? `${pathOf(scope.parent)}/${scope.name}` : "");
// Nome de PDF com os caracteres especiais em #xx.
const escapeName = (name) => name.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const translation = ([dx, dy]) => [1, 0, 0, 1, dx, dy];

/** Os pedaços (bytes ou texto) emendados. Recebe uma lista: espalhar milhares de pedaços como argumentos estoura a pilha. */
function concat(parts) {
  const chunks = parts.map((p) => (typeof p === "string" ? encoder.encode(p) : p));
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function boxOf(points) {
  if (!points.length) return null;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }
  return box;
}

/** A caixa que contém todas as caixas `rects` (null se nenhuma). */
export function unionRect(rects) {
  let box = null;
  for (const r of rects) {
    if (!r) continue;
    if (!box) box = [...r];
    else {
      if (r[0] < box[0]) box[0] = r[0];
      if (r[1] < box[1]) box[1] = r[1];
      if (r[2] > box[2]) box[2] = r[2];
      if (r[3] > box[3]) box[3] = r[3];
    }
  }
  return box;
}

const intersect = (a, b) => (a && b ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : a || b);
const expand = (r, pad) => (r ? [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad] : r);
const shift = (r, [dx, dy]) => (r ? [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy] : r);
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
const valid = (r) => (r && r.every(Number.isFinite) && r[0] <= r[2] && r[1] <= r[3] ? r : null);

/** Chave de um trecho de texto (de findTextRuns) entre os objetos da página. */
export const textKey = (run) => `text:${pathOf(run.scope)}@${run.start}`;

/** Caixa de um trecho de texto na página: as letras, ou da origem ao fim quando ele só tem espaços. */
function textBox(run) {
  const box = unionRect(glyphBoxes(run));
  if (box) return box;
  return expand(boxOf([run.origin, run.endPoint || run.origin]), run.size / 2);
}

function numbersOf(context, array) {
  const values = array?.asArray?.().map((v) => context.lookup(v)?.asNumber?.()) ?? [];
  return values.every(Number.isFinite) ? values : [];
}

function formMatrix(context, stream) {
  const m = numbersOf(context, stream.dict.lookup(key("Matrix")));
  return m.length === 6 ? m : IDENTITY;
}

/** Caixa na página de um formulário desenhado com `ctm` (null sem /BBox válida). */
function formBox(context, stream, ctm) {
  const bbox = numbersOf(context, stream.dict.lookup(key("BBox")));
  if (bbox.length !== 4) return null;
  const t = multiply(formMatrix(context, stream), ctm);
  return boxOf([
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[0], bbox[3]],
    [bbox[2], bbox[3]],
  ].map(([x, y]) => transformPoint(t, x, y)));
}

const pageOf = (doc, page) => (typeof page === "number" ? doc.getPage(page) : page);

/**
 * Se uma camada (grupo de conteúdo opcional ou a combinação de grupos de um
 * OCMD, pela referência `value`) está escondida na configuração com que o
 * documento abre.
 */
function layerTest(doc) {
  const props = doc.catalog.lookup(key("OCProperties"));
  const config = props instanceof PDFDict ? props.lookup(key("D")) : null;
  if (!(config instanceof PDFDict)) return () => false;
  const refs = (dict, name) => {
    const list = dict.lookup(key(name));
    return list instanceof PDFArray ? list.asArray().filter((v) => v instanceof PDFRef) : [];
  };
  const off = new Set();
  if (config.lookup(key("BaseState")) === key("OFF")) {
    const on = new Set(refs(config, "ON"));
    for (const ref of refs(props, "OCGs")) if (!on.has(ref)) off.add(ref);
  } else refs(config, "OFF").forEach((ref) => off.add(ref));
  return (value) => {
    if (!(value instanceof PDFRef)) return false;
    const dict = doc.context.lookup(value);
    if (!(dict instanceof PDFDict) || dict.lookup(key("Type")) !== key("OCMD")) return off.has(value);
    const groups = dict.get(key("OCGs"));
    const list = groups instanceof PDFRef ? [groups] : groups instanceof PDFArray ? groups.asArray() : [];
    if (!list.length) return false;
    const hidden = list.map((ref) => off.has(ref));
    const policy = dict.lookup(key("P"))?.decodeText?.() || "AnyOn";
    if (policy === "AllOn") return hidden.some(Boolean);
    if (policy === "AnyOff") return !hidden.some(Boolean);
    if (policy === "AllOff") return !hidden.every(Boolean);
    return hidden.every(Boolean);
  };
}

// ---- Leitura ----

/**
 * Os objetos da página (índice ou PDFPage), na ordem em que são desenhados (o
 * último fica por cima): { key, kind (text, image, inline, path, shading ou
 * form), rect [x0, y0, x1, y1] na página (null se não aparece), invisible
 * (texto invisível, como o do OCR), blank (texto só com espaços), hidden
 * (numa camada escondida) }, e por
 * dentro o que é preciso para apagá-los e redesenhá-los. `runs`: os trechos de
 * texto da página, se já lidos.
 */
export function pageObjects(doc, page, { content = null, runs = null } = {}) {
  page = pageOf(doc, page);
  content ??= readPageContent(doc, page);
  runs ??= findTextRuns(doc, page, content);
  const texts = new Map(runs.map((run) => [textKey(run), run]));
  const box = page.getMediaBox();
  const ctx = {
    context: doc.context,
    texts,
    objects: [],
    forms: { count: 0, bytes: 0 },
    pageBox: [box.x, box.y, box.x + box.width, box.y + box.height],
    hiddenLayer: layerTest(doc),
  };
  const state = { ctm: IDENTITY, entries: [], clip: null, lineWidth: 1 };
  walk(ctx, content, page.node.Resources(), null, state, { marks: [], root: null, depth: 0 });
  ctx.objects.forEach((o, i) => {
    o.index = i;
    o.key = o.kind === "text" ? textKey(o.run) : `${o.kind}:${pathOf(o.scope)}@${o.start}`;
  });
  return ctx.objects;
}

/**
 * Percorre um conteúdo (da página ou de um formulário) guardando o estado
 * gráfico em vigor como a lista de comandos que o refazem: o último de cada
 * tipo (cor, espessura, fonte...), as transparências (gs) e os recortes, cada
 * um com a matriz e os recursos de onde apareceu. `marks`: as camadas (/OC)
 * abertas em volta; `root`: onde começa, no conteúdo da página, o comando que
 * leva a este formulário.
 */
function walk(ctx, content, resources, scope, initial, { marks: outerMarks, root, depth }) {
  const { context } = ctx;
  const xobjects = resources?.lookup(key("XObject"));
  const states = resources?.lookup(key("ExtGState"));
  const ops = parseOperations(content);
  // Formulário desenhado mais de uma vez neste conteúdo: vira um objeto só
  // (mexer no que tem dentro mudaria todas as vezes). As mesmas regras de
  // findTextRuns, para os trechos de texto baterem.
  const uses = new Map();
  for (const o of ops) {
    if (o.op === "Do" && o.operands[0]?.type === "name") uses.set(o.operands[0].value, (uses.get(o.operands[0].value) || 0) + 1);
  }
  const bytesOf = (start, end) => content.subarray(start, end);
  const stack = [];
  let s = { ...initial };
  // Conteúdo marcado aberto: { oc } com o comando da camada, ou {} nos outros.
  const marked = [];
  let marks = outerMarks;
  let path = null;
  let inline = null;
  const entry = (o, used = [], extra = {}) => ({ bytes: bytesOf(o.start, o.end), scope, resources, used, ...extra });
  const synthetic = (text) => ({ bytes: encoder.encode(text), scope, resources, used: [] });
  const setSlot = (slot, value, ...cleared) => {
    s.entries = [...s.entries.filter((e) => e.slot !== slot && !cleared.includes(e.slot)), { ...value, slot }];
  };
  const object = (kind, start, end, rect, extra = {}) => {
    ctx.objects.push({
      kind,
      scope,
      resources,
      start,
      end,
      root: root ?? start,
      ctm: s.ctm,
      entries: s.entries,
      marks,
      hidden: marks.some((m) => m.hidden),
      rect: valid(intersect(rect, s.clip)),
      bytes: bytesOf(start, end),
      used: [],
      ...extra,
    });
  };
  for (const o of ops) {
    const n = o.operands.filter((t) => t.type === "number").map((t) => t.value);
    const name = o.operands.find((t) => t.type === "name")?.value ?? null;
    switch (o.op) {
      case "q":
        stack.push({ ...s });
        break;
      case "Q":
        s = stack.pop() || s;
        break;
      case "cm":
        if (n.length === 6) s.ctm = multiply(n, s.ctm);
        break;
      case "w":
        s.lineWidth = n[0] ?? s.lineWidth;
        setSlot("w", entry(o));
        break;
      case "J":
      case "j":
      case "M":
      case "d":
      case "ri":
      case "i":
      case "Tc":
      case "Tw":
      case "Tz":
      case "TL":
      case "Tr":
      case "Ts":
        setSlot(o.op, entry(o));
        break;
      case "TD":
        setSlot("TL", synthetic(`${fmt(-(n[1] ?? 0))} TL`));
        break;
      case "Tf":
        setSlot("Tf", entry(o, name ? [["Font", name]] : []));
        break;
      case "g":
      case "rg":
      case "k":
        setSlot("fill", entry(o), "fillSpace");
        break;
      case "G":
      case "RG":
      case "K":
        setSlot("stroke", entry(o), "strokeSpace");
        break;
      case "cs":
        setSlot("fillSpace", entry(o, name && !DEVICE_SPACES.has(name) ? [["ColorSpace", name]] : []), "fill");
        break;
      case "CS":
        setSlot("strokeSpace", entry(o, name && !DEVICE_SPACES.has(name) ? [["ColorSpace", name]] : []), "stroke");
        break;
      case "sc":
      case "scn":
        setSlot("fill", entry(o, name ? [["Pattern", name]] : []));
        break;
      case "SC":
      case "SCN":
        setSlot("stroke", entry(o, name ? [["Pattern", name]] : []));
        break;
      case "gs": {
        if (!name) break;
        // A transparência (máscara suave) é posicionada pela matriz da hora. Um
        // gs que muda tudo o que um anterior mudava toma o lugar dele.
        const dict = states instanceof PDFDict ? states.lookup(key(name)) : null;
        const sets = dict instanceof PDFDict ? dict.keys().map((k) => k.decodeText()).filter((k) => k !== "Type") : null;
        const covered = (e) => e.sets && sets && e.sets.every((k) => sets.includes(k));
        s.entries = [...s.entries.filter((e) => !(e.gs && covered(e))), entry(o, [["ExtGState", name]], { ctm: s.ctm, gs: true, sets })];
        break;
      }
      case "BMC":
        marked.push({});
        break;
      case "BDC": {
        // Camada (conteúdo opcional): a cópia fica na mesma camada.
        const tag = o.operands[0]?.type === "name" ? o.operands[0].value : null;
        const props = o.operands[1]?.type === "name" ? o.operands[1].value : null;
        if (tag === "OC" && props) {
          const layer = resources?.lookup(key("Properties"))?.get?.(key(props));
          const oc = entry(o, [["Properties", props]], { tagged: true, hidden: ctx.hiddenLayer(layer) });
          marked.push({ oc });
          marks = [...marks, oc];
        } else marked.push({});
        break;
      }
      case "EMC":
        if (marked.pop()?.oc) marks = marks.slice(0, -1);
        break;
      case "m":
      case "l":
      case "c":
      case "v":
      case "y":
      case "h":
      case "re": {
        path ||= { start: o.start, points: [], clipEnd: null };
        if (o.op === "re" && n.length === 4) {
          const [x, y, w, h] = n;
          path.points.push([x, y], [x + w, y], [x, y + h], [x + w, y + h]);
        } else {
          for (let i = 0; i + 1 < n.length; i += 2) path.points.push([n[i], n[i + 1]]);
        }
        break;
      }
      case "W":
      case "W*":
        if (path) path.clipEnd = o.end;
        break;
      case "BI":
        inline = { start: o.start, dict: null };
        break;
      case "ID":
        if (inline) inline.dict = o;
        break;
      case "EI":
        if (inline) {
          object("inline", inline.start, o.end, unitBox(s.ctm), { used: inlineResources(inline.dict) });
          inline = null;
        }
        break;
      case "sh":
        // Degradê: pinta toda a área recortada.
        if (name) object("shading", o.start, o.end, ctx.pageBox, { used: [["Shading", name]] });
        break;
      case "Do": {
        if (!name || !(xobjects instanceof PDFDict)) break;
        const stream = xobjects.lookup(key(name));
        if (!(stream instanceof PDFStream)) break;
        const subtype = stream.dict.lookup(key("Subtype"));
        const hidden = marks.some((m) => m.hidden) || ctx.hiddenLayer(stream.dict.get(key("OC")));
        if (subtype === key("Image")) {
          object("image", o.start, o.end, unitBox(s.ctm), { used: [["XObject", name]], name, hidden });
          break;
        }
        if (subtype !== key("Form")) break;
        const over = () => ++ctx.forms.count > FORM_BUDGET.count || ctx.forms.bytes > FORM_BUDGET.bytes;
        let formContent = null;
        if (depth < MAX_DEPTH && uses.get(name) === 1 && !over()) {
          try {
            formContent = decodeStream(stream);
          } catch {
            formContent = null;
          }
        }
        if (formContent) ctx.forms.bytes += formContent.length;
        // Formulário numa camada própria: levar o que tem dentro para fora o tiraria dela.
        if (!formContent || stream.dict.has(key("OC"))) {
          object("form", o.start, o.end, formBox(context, stream, s.ctm), { used: [["XObject", name]], name, hidden });
          break;
        }
        const own = stream.dict.lookup(key("Resources"));
        const ctm = multiply(formMatrix(context, stream), s.ctm);
        // `base`: o espaço dos padrões (Pattern) usados no formulário.
        const child = { name, stream, parent: scope, resources: own instanceof PDFDict ? own : resources, base: ctm };
        const state = { ...s, ctm };
        // O formulário só aparece dentro da caixa dele: a cópia leva esse recorte.
        const bbox = numbersOf(context, stream.dict.lookup(key("BBox")));
        if (bbox.length === 4) {
          const [x0, y0, x1, y1] = bbox;
          const clip = encoder.encode(`${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re W n`);
          state.entries = [...s.entries, { bytes: clip, scope: child, resources: child.resources, used: [], ctm }];
          state.clip = intersect(s.clip, formBox(context, stream, s.ctm));
        }
        walk(ctx, formContent, child.resources, child, state, { marks, root: root ?? o.start, depth: depth + 1 });
        break;
      }
      default:
        if (PAINT.has(o.op)) {
          if (path) {
            const rect = boxOf(path.points.map(([x, y]) => transformPoint(s.ctm, x, y)));
            if (path.clipEnd !== null) {
              // Recorte: vale para o que vem depois, até o Q. Pintar e recortar
              // ao mesmo tempo não vira objeto (apagá-lo levaria o recorte junto).
              s.entries = [...s.entries, { bytes: concat([bytesOf(path.start, path.clipEnd), " n"]), scope, resources, used: [], ctm: s.ctm }];
              s.clip = intersect(s.clip, rect);
            } else if (o.op !== "n" && rect) {
              const pad = FILL_ONLY.has(o.op) ? 0 : (Math.max(s.lineWidth, 0.5) * scaleOf(s.ctm)) / 2;
              object("path", path.start, o.end, expand(rect, pad));
            }
          }
          path = null;
        } else if (SHOW.has(o.op)) {
          if (o.op === '"' && n.length >= 2) {
            setSlot("Tw", synthetic(`${fmt(n[0])} Tw`));
            setSlot("Tc", synthetic(`${fmt(n[1])} Tc`));
          }
          const run = ctx.texts.get(`text:${pathOf(scope)}@${o.start}`);
          const inverse = invert(s.ctm);
          // Só o texto com a posição conhecida; o que entra no recorte (Tr 4 a 7) fica.
          if (!run?.known || !inverse || run.mode >= 4) break;
          let bytes = bytesOf(o.start, o.end);
          if (o.op === "'" || o.op === '"') {
            const text = o.operands.filter((t) => t.type === "string" || t.type === "hex").pop();
            if (!text) break;
            bytes = concat([bytesOf(text.start, text.end), " Tj"]);
          }
          // `blank`: só espaços (não desenha nada).
          const blank = run.layout.every((item) => item.code === undefined || !item.visible);
          object("text", o.start, o.end, textBox(run), { run, tm: multiply(run.trm, inverse), invisible: run.mode === 3, blank, bytes });
        }
    }
  }
}

/** Recursos de uma imagem embutida: o espaço de cor, quando ele tem nome. */
function inlineResources(dict) {
  if (!dict) return [];
  const tokens = dict.operands;
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i].type === "name" && (tokens[i].value === "CS" || tokens[i].value === "ColorSpace") && tokens[i + 1].type === "name") {
      const value = tokens[i + 1].value;
      return DEVICE_SPACES.has(value) ? [] : [["ColorSpace", value]];
    }
  }
  return [];
}

// ---- Escrita ----

/** Os bytes do comando com os nomes de recursos trocados por `rename(item, categoria, nome)`. */
function withNames(item, rename) {
  if (!item.used.length) return item.bytes;
  const changes = new Map();
  for (const [category, name] of item.used) {
    const next = rename(item, category, name);
    if (next !== name) changes.set(name, next);
  }
  if (!changes.size) return item.bytes;
  const parts = [];
  let at = 0;
  let previous = null;
  let names = 0;
  for (const token of tokenize(item.bytes)) {
    // Na imagem embutida, só o valor de /CS é recurso (as chaves também são nomes);
    // em "/OC /nome BDC", o primeiro nome é a marca.
    const isValue =
      item.kind === "inline" ? previous?.type === "name" && (previous.value === "CS" || previous.value === "ColorSpace") : !(item.tagged && names === 0);
    if (token.type === "name") {
      if (changes.has(token.value) && isValue) {
        parts.push(item.bytes.subarray(at, token.start), `/${escapeName(changes.get(token.value))}`);
        at = token.end;
      }
      names++;
    }
    previous = token;
    if (token.type === "op" && token.value === "ID") break;
  }
  parts.push(item.bytes.subarray(at));
  return concat(parts);
}

/**
 * Os comandos que redesenham os objetos de `items` ({ obj, delta [dx, dy] no
 * espaço da página }), por cima de tudo e na ordem da lista. Objetos seguidos
 * com o mesmo estado ficam no mesmo bloco q ... Q. Com `layers`, a cópia fica
 * na mesma camada do original. Devolve os bytes e, de cada item, onde o bloco
 * dele fica nos bytes (null se não deu para desenhar).
 */
function drawCopies(items, rename, { layers = true } = {}) {
  const parts = [];
  const ranges = [];
  let length = 0;
  const push = (...chunks) => {
    for (const chunk of chunks) {
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      parts.push(bytes);
      length += bytes.length;
    }
  };
  let open = null;
  const close = () => {
    if (!open) return;
    push("EMC\n".repeat(open.marks.length), "Q\n");
    open.range[1] = length;
    open = null;
  };
  const none = [];
  items.forEach((item, i) => {
    const { obj, delta } = item;
    const marks = layers ? obj.marks : none;
    const named = (e) => withNames(e, (entry, cat, name) => rename(entry, cat, name, delta));
    const same =
      open &&
      open.entries === obj.entries &&
      open.marks === marks &&
      open.delta[0] === delta[0] &&
      open.delta[1] === delta[1] &&
      open.ctm.every((v, k) => v === obj.ctm[k]);
    if (!same) {
      close();
      const move = translation(delta);
      const own = [];
      let current = IDENTITY;
      const goTo = (ctm) => {
        const target = multiply(ctm, move);
        const inverse = invert(current);
        if (!inverse) return false;
        const m = multiply(target, inverse);
        if (!isIdentity(m)) own.push(`${m.map(fmt).join(" ")} cm\n`);
        current = target;
        return true;
      };
      let ok = true;
      for (const entry of obj.entries) {
        if (entry.ctm && !goTo(entry.ctm)) {
          ok = false;
          break;
        }
        own.push(named(entry), "\n");
      }
      if (!ok || !goTo(obj.ctm)) {
        ranges[i] = null;
        return;
      }
      open = { entries: obj.entries, marks, ctm: obj.ctm, delta, range: [length, length] };
      push("q\n", ...own);
      for (const mark of marks) push(named(mark), "\n");
    }
    ranges[i] = open.range;
    if (obj.kind === "text") push(`BT\n${obj.tm.map(fmt).join(" ")} Tm\n`, named(obj), "\nET\n");
    else push(named(obj), "\n");
  });
  close();
  return { bytes: concat(parts), ranges };
}

/**
 * Leva para os recursos de `page` (em `doc`) os recursos usados pelos objetos,
 * copiados quando vêm de outro documento (`source`). O nome muda quando a
 * página já usa o mesmo nome para outra coisa. Os recursos da página ficam só
 * dela (podiam ser os mesmos de outras páginas). Um padrão (Pattern) é
 * posicionado em relação à página: a cópia ganha um padrão deslocado junto.
 */
function resourceImporter(doc, page, source) {
  const { context } = doc;
  const copier = source === doc ? null : PDFObjectCopier.for(source.context, context);
  if (copier) reuseStreams(source.context, context, copier);
  const names = new Map();
  let own = null;
  const categories = new Map();
  const category = (cat, write) => {
    if (categories.has(cat)) return categories.get(cat);
    const current = (own || page.node.Resources())?.lookup(key(cat));
    if (!write) return current instanceof PDFDict ? current : null;
    if (!own) {
      const resources = page.node.Resources();
      own = resources instanceof PDFDict ? resources.clone(context) : context.obj({});
      page.node.set(key("Resources"), own);
    }
    const dict = current instanceof PDFDict ? current.clone(context) : context.obj({});
    own.set(key(cat), dict);
    categories.set(cat, dict);
    return dict;
  };
  return (item, cat, name, delta = [0, 0]) => {
    const pattern = cat === "Pattern" ? multiply(item.scope?.base ?? IDENTITY, translation(delta)) : null;
    const moved = pattern && !isIdentity(pattern);
    const id = `${pathOf(item.scope)}|${cat}|${name}|${moved ? pattern.join(",") : ""}`;
    if (names.has(id)) return names.get(id);
    let value = item.resources?.lookup(key(cat))?.get?.(key(name));
    let target = name;
    if (value !== undefined) {
      if (copier) value = copier.copy(value);
      if (moved) value = movedPattern(context, value, pattern);
      const existing = category(cat, false);
      for (let k = 1; existing?.has(key(target)) && existing.get(key(target)) !== value; k++) target = `${name}_${k}`;
      if (!existing?.has(key(target))) category(cat, true).set(key(target), value);
    }
    names.set(id, target);
    return target;
  };
}

/** Uma cópia do padrão `value` com a matriz levada por `m` (ou o próprio, se não der). */
function movedPattern(context, value, m) {
  const pattern = context.lookup(value);
  const dict = pattern instanceof PDFStream ? pattern.dict : pattern;
  if (!(dict instanceof PDFDict)) return value;
  try {
    const p = numbersOf(context, dict.lookup(key("Matrix")));
    const copy = pattern.clone(context);
    (copy instanceof PDFStream ? copy.dict : copy).set(key("Matrix"), context.obj(multiply(p.length === 6 ? p : IDENTITY, m)));
    return context.register(copy);
  } catch {
    return value;
  }
}

/**
 * Ao copiar de outro documento, as imagens e fontes que ele já tem (os mesmos
 * bytes, de um "colar" anterior ou do próprio documento) são reaproveitadas,
 * sem guardar duas vezes.
 */
function reuseStreams(from, to, copier) {
  const sizes = new Map();
  for (const [ref, obj] of to.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 512) continue;
    if (!sizes.has(obj.contents.length)) sizes.set(obj.contents.length, []);
    sizes.get(obj.contents.length).push([ref, obj]);
  }
  if (!sizes.size) return;
  // Mesmo valor: as referências de dentro precisam já estar reaproveitadas.
  const same = (a, b) => {
    if (a instanceof PDFRef) return b instanceof PDFRef && copier.traversedObjects.get(a) === b;
    if (a instanceof PDFDict) return b instanceof PDFDict && sameDict(a, b);
    if (a instanceof PDFArray) return b instanceof PDFArray && a.size() === b.size() && a.asArray().every((v, i) => same(v, b.get(i)));
    return !(b instanceof PDFRef || b instanceof PDFDict || b instanceof PDFArray) && String(a) === String(b);
  };
  const sameDict = (a, b) => {
    const entries = a.entries().filter(([k]) => k !== key("Length"));
    return entries.length === b.entries().filter(([k]) => k !== key("Length")).length && entries.every(([k, v]) => b.has(k) && same(v, b.get(k)));
  };
  const pending = [...from.enumerateIndirectObjects()].filter(([, obj]) => obj instanceof PDFRawStream && sizes.has(obj.contents.length));
  // Primeiro os que não apontam para outros (máscaras, arquivos de fonte), depois os que dependem deles.
  for (let changed = true; changed && pending.length; ) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const [ref, obj] = pending[i];
      const match = sizes
        .get(obj.contents.length)
        .find(([, other]) => sameDict(obj.dict, other.dict) && other.contents.every((b, k) => b === obj.contents[k]));
      if (!match) continue;
      copier.traversedObjects.set(ref, match[0]);
      pending.splice(i, 1);
      changed = true;
    }
  }
}

/**
 * Desenha cópias dos objetos de `items` (lidos em `source`) por cima de tudo
 * na página `page` de `doc`. Em outro documento, as cópias ficam fora das
 * camadas (elas não existem lá). Devolve as chaves que os objetos marcados com
 * `target` passam a ter na página.
 */
function appendCopies(doc, page, source, items) {
  if (!items.length) return [];
  const { bytes, ranges } = drawCopies(items, resourceImporter(doc, page, source), { layers: source === doc });
  if (!bytes.length) return [];
  isolatePage(doc, page);
  // Direto na lista: depois de o conteúdo ser reescrito num stream só (ao apagar
  // os originais), o pdf-lib não o transformaria em lista de novo.
  const ref = doc.context.register(doc.context.flateStream(bytes));
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) contents.push(ref);
  else page.node.set(key("Contents"), doc.context.obj(contents ? [page.node.get(key("Contents")), ref] : [ref]));
  // Onde os blocos novos ficam no conteúdo da página, para achar os objetos de novo.
  const content = readPageContent(doc, page);
  const offset = content.length - bytes.length - 1;
  const wanted = items.map((item, i) => (item.target ? ranges[i] : null)).filter(Boolean);
  return pageObjects(doc, page, { content })
    .filter((o) => {
      const at = o.root - offset;
      return at >= 0 && wanted.some(([from, to]) => at >= from && at < to);
    })
    .map((o) => o.key);
}

/**
 * Tira os objetos da página no lugar deles, sem mexer no resto: o texto vira
 * um avanço vazio do mesmo tamanho e o resto, espaços. Um bloco q ... Q que só
 * desenha objetos que saem vai embora inteiro (com o estado e os recortes
 * dele), para o conteúdo não acumular sobras a cada vez que algo é movido. Um
 * formulário mexido vira uma cópia só desta página.
 */
function blankObjects(doc, page, objects) {
  const copies = pageCopies(doc, page);
  const groups = new Map();
  for (const obj of objects) {
    const path = pathOf(obj.scope);
    if (!groups.has(path)) groups.set(path, { scope: obj.scope, objects: [] });
    groups.get(path).objects.push(obj);
  }
  for (const { scope, objects: list } of groups.values()) {
    const content = scope ? decodeStream(scope.stream) : readPageContent(doc, page);
    copies.setContent(scope, rewriteContent(content, blankEdits(content, list)));
  }
}

// Comandos que desenham (o fim de um caminho, um texto, uma imagem...).
const DRAWS = new Set(["f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "sh", "Do", "EI", "Tj", "TJ", "'", '"']);

/** O que trocar no conteúdo para tirar `objects` dele (veja blankObjects). */
function blankEdits(content, objects) {
  const byStart = new Map(objects.map((o) => [o.start, o]));
  const byEnd = new Map(objects.filter((o) => o.kind === "inline").map((o) => [o.end, o]));
  // Blocos q ... Q: limpos se só desenham o que sai e o conteúdo marcado fecha dentro deles.
  const blocks = [];
  const open = [];
  let pathStart = null;
  for (const o of parseOperations(content)) {
    const top = open[open.length - 1];
    if (o.op === "q") {
      open.push({ start: o.start, end: null, clean: true, marks: 0, hits: [] });
    } else if (o.op === "Q") {
      const block = open.pop();
      if (!block) continue;
      block.end = o.end;
      if (block.marks !== 0) block.clean = false;
      blocks.push(block);
      const parent = open[open.length - 1];
      if (parent) {
        parent.clean &&= block.clean;
        for (const obj of block.hits) parent.hits.push(obj);
      }
    } else if (o.op === "BMC" || o.op === "BDC") {
      if (top) top.marks++;
    } else if (o.op === "EMC") {
      if (top && --top.marks < 0) top.clean = false;
    } else if ((o.op === "m" || o.op === "re") && pathStart === null) {
      pathStart = o.start;
    } else if (DRAWS.has(o.op) || o.op === "n") {
      // Um caminho é achado pelo primeiro m/re; a imagem embutida, pelo EI.
      const isPath = PAINT.has(o.op);
      const obj = isPath ? byStart.get(pathStart) : o.op === "EI" ? byEnd.get(o.end) : byStart.get(o.start);
      if (isPath) pathStart = null;
      if (!top) continue;
      if (obj) top.hits.push(obj);
      else if (o.op !== "n") top.clean = false;
    }
  }
  // O maior bloco limpo em volta dos objetos sai inteiro.
  const whole = blocks.filter((b) => b.clean && b.hits.length).sort((a, b) => b.end - b.start - (a.end - a.start));
  const edits = [];
  const covered = new Set();
  for (const block of whole) {
    if (block.hits.some((obj) => covered.has(obj))) continue;
    if (edits.some((e) => block.start < e.end && e.start < block.end)) continue;
    edits.push({ start: block.start, end: block.end, text: "" });
    block.hits.forEach((obj) => covered.add(obj));
  }
  for (const obj of objects) {
    if (!covered.has(obj)) edits.push({ start: obj.start, end: obj.end, text: obj.kind === "text" ? blankReplacement(obj.run) : "" });
  }
  return edits;
}

const chosen = (objects, keys) => {
  const wanted = new Set(keys);
  return objects.filter((o) => wanted.has(o.key));
};

/**
 * Desloca na página `page` (índice ou PDFPage) os objetos `keys` (de
 * pageObjects) em `delta` [dx, dy] (pontos do PDF): o original sai do lugar e
 * uma cópia exata fica por cima. O que estava por cima de um objeto movido
 * continua por cima dele (é desenhado de novo, no mesmo lugar). Com `keep`, o
 * original fica (duplicar). Devolve as chaves dos objetos movidos (ou das
 * cópias) na página.
 */
export function moveObjects(doc, page, keys, delta, { keep = false } = {}) {
  page = pageOf(doc, page);
  const all = pageObjects(doc, page);
  const targets = new Set(chosen(all, keys));
  if (!targets.size) return [];
  if (keep) return appendCopies(doc, page, doc, [...targets].map((obj) => ({ obj, delta, target: true })));
  const items = [];
  const above = [];
  for (const obj of all) {
    if (targets.has(obj)) {
      items.push({ obj, delta, target: true });
      if (obj.rect) above.push(shift(obj.rect, delta));
    } else if (above.length && obj.rect && !obj.invisible && above.some((r) => overlaps(r, obj.rect))) {
      items.push({ obj, delta: [0, 0], target: false });
      above.push(obj.rect);
    }
  }
  blankObjects(doc, page, items.map((item) => item.obj));
  return appendCopies(doc, page, doc, items);
}

/** Tira da página (índice ou PDFPage) os objetos `keys`. Devolve quantos saíram. */
export function deleteObjects(doc, page, keys) {
  page = pageOf(doc, page);
  const targets = chosen(pageObjects(doc, page), keys);
  if (targets.length) blankObjects(doc, page, targets);
  return targets.length;
}

/**
 * Os objetos `keys` da página num PDF à parte, para colar: uma página do mesmo
 * tamanho, com eles no mesmo lugar e só os recursos que eles usam. Devolve
 * { pdf (bytes), rect (a caixa de todos), count }.
 */
export async function copyObjects(doc, page, keys) {
  page = pageOf(doc, page);
  const targets = chosen(pageObjects(doc, page), keys);
  const clip = await PDFDocument.create({ updateMetadata: false });
  const media = page.getMediaBox();
  const target = clip.addPage([media.width, media.height]);
  target.setMediaBox(media.x, media.y, media.width, media.height);
  const crop = page.getCropBox();
  target.setCropBox(crop.x, crop.y, crop.width, crop.height);
  target.setRotation(page.getRotation());
  appendCopies(clip, target, doc, targets.map((obj) => ({ obj, delta: [0, 0], target: true })));
  return { pdf: await clip.save(), rect: unionRect(targets.map((o) => o.rect)), count: targets.length };
}

/**
 * Cola na página `page` (índice ou PDFPage) os objetos de `pdf` (de
 * copyObjects), deslocados de `delta`, por cima do resto. Devolve as chaves
 * dos objetos colados.
 */
export async function pasteObjects(doc, page, pdf, delta = [0, 0]) {
  page = pageOf(doc, page);
  const clip = await PDFDocument.load(pdf, { updateMetadata: false });
  const objects = pageObjects(clip, clip.getPage(0));
  return appendCopies(doc, page, clip, objects.map((obj) => ({ obj, delta, target: true })));
}
