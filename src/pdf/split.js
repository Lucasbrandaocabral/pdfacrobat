// Como dividir um PDF: os grupos de páginas (índices a partir do 0) que viram
// cada arquivo. Intervalos personalizados ou fixos, os inícios de documento
// achados no modo inteligente e o tamanho máximo de cada arquivo.
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } from "@cantoo/pdf-lib";

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => from + k);

/** Arquivos de `size` páginas (o último com o que sobrar). */
export function fixedGroups(total, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const groups = [];
  for (let i = 0; i < total; i += n) groups.push(range(i, Math.min(total, i + n) - 1));
  return groups;
}

/**
 * Intervalos escolhidos ({ from, to }, contando do 1). Lança um erro com a
 * mensagem para o usuário quando um intervalo não faz sentido.
 */
export function customGroups(ranges, total) {
  if (!ranges.length) throw new Error("Adicione pelo menos um intervalo.");
  return ranges.map(({ from, to }, k) => {
    const a = Math.floor(from);
    const b = Math.floor(to);
    if (!(a >= 1 && b >= 1)) throw new Error(`Intervalo ${k + 1}: informe a primeira e a última página.`);
    if (a > total || b > total) throw new Error(`Intervalo ${k + 1}: o documento tem ${total} página${total === 1 ? "" : "s"}.`);
    if (a > b) throw new Error(`Intervalo ${k + 1}: a primeira página (${a}) vem depois da última (${b}).`);
    return range(a - 1, b - 1);
  });
}

/**
 * Documentos que começam nas páginas `starts`. As páginas de `skip` (as em
 * branco que separam os documentos, por exemplo) ficam de fora.
 */
export function groupsFromStarts(total, starts, skip = new Set()) {
  const marks = [...new Set([0, ...starts])].filter((i) => i >= 0 && i < total).sort((a, b) => a - b);
  const groups = [];
  marks.forEach((start, k) => {
    const end = k + 1 < marks.length ? marks[k + 1] - 1 : total - 1;
    const pages = range(start, end).filter((i) => !skip.has(i));
    if (pages.length) groups.push(pages);
  });
  return groups;
}

/** Documentos separados por páginas em branco (que não entram em nenhum). */
export function groupsBetweenBlanks(total, blanks) {
  const starts = [...blanks].map((i) => i + 1);
  return groupsFromStarts(total, starts, blanks);
}

const OVERHEAD = 600;

/**
 * O que cada página usa do arquivo: o tamanho do próprio dicionário (`base`) e
 * os objetos que ela usa (conteúdo, fontes, imagens), com o tamanho de cada um
 * (`size`). Um recurso usado por várias páginas entra uma vez em cada arquivo.
 */
export function pageResources(doc) {
  const PAGE = PDFName.of("Page");
  // A árvore de páginas (Parent) e o vínculo de volta à página (P) ficam de fora.
  const SKIP = new Set([PDFName.of("Parent"), PDFName.of("P")]);
  const isPage = (obj) => obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PAGE;
  const size = new Map();
  const base = [];
  const objects = doc.getPages().map((page) => {
    const used = new Set();
    const visit = (obj) => {
      if (obj instanceof PDFRef) {
        if (used.has(obj.tag) || obj === page.ref) return;
        const target = doc.context.lookup(obj);
        // Outra página (destino de um link): não vai junto.
        if (!target || isPage(target)) return;
        used.add(obj.tag);
        if (!size.has(obj.tag)) size.set(obj.tag, target.sizeInBytes?.() ?? 0);
        visit(target);
      } else if (obj instanceof PDFStream) {
        visit(obj.dict);
      } else if (obj instanceof PDFDict) {
        for (const [key, value] of obj.entries()) if (!SKIP.has(key)) visit(value);
      } else if (obj instanceof PDFArray) {
        obj.asArray().forEach(visit);
      }
    };
    visit(page.node);
    // Recursos herdados da árvore de páginas também vão junto.
    if (!page.node.get(PDFName.of("Resources"))) visit(page.node.Resources?.());
    base.push(page.node.sizeInBytes?.() ?? 0);
    return used;
  });
  return { base, objects, size };
}

/** Tamanho aproximado de cada página sozinha num arquivo. */
export function pageSizes(resources) {
  return resources.objects.map((used, i) => {
    let total = OVERHEAD + resources.base[i];
    for (const tag of used) total += resources.size.get(tag);
    return total;
  });
}

/**
 * Arquivos de até `limit` bytes, na ordem das páginas, contando cada recurso
 * uma vez por arquivo. Uma página que sozinha passa do limite vira um arquivo
 * só dela.
 */
export function sizeGroups(resources, limit) {
  const groups = [];
  let current = [];
  let seen = new Set();
  let used = OVERHEAD;
  const cost = (i) => {
    let total = resources.base[i];
    for (const tag of resources.objects[i]) if (!seen.has(tag)) total += resources.size.get(tag);
    return total;
  };
  resources.objects.forEach((objects, i) => {
    let add = cost(i);
    if (current.length && used + add > limit) {
      groups.push(current);
      current = [];
      seen = new Set();
      used = OVERHEAD;
      add = cost(i);
    }
    current.push(i);
    used += add;
    objects.forEach((tag) => seen.add(tag));
  });
  if (current.length) groups.push(current);
  return groups;
}

// ---- Modo inteligente: onde começa cada documento ----

/** Texto sem acentos e em minúsculas, para comparar. */
export function normalize(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// "Página 1 de 5", "Pág. 1/5", "Page 1 of 5", "Folha 1 de 3", "Fls. 01/04".
const FIRST_PAGE = /\b(?:pagina|pag\.?|page|folha|fls?\.?)\s*0*1\s*(?:de|of|\/)\s*0*\d+/;

/** Páginas em que a numeração recomeça ("Página 1 de ..."). */
export function numberingStarts(texts) {
  return texts.flatMap((text, i) => (FIRST_PAGE.test(normalize(text)) ? [i] : []));
}

// "Página 2 de 3", "Folha 2/2": continuação de um documento.
const LATER_PAGE = /\b(?:pagina|pag\.?|page|folha|fls?\.?)\s*0*(?:[2-9]|[1-9]\d+)\s*(?:de|of|\/)\s*0*\d+/;

/**
 * Páginas que contêm a palavra (sem diferenciar maiúsculas e acentos), menos
 * as que se dizem continuação ("Página 2 de 3").
 */
export function keywordStarts(texts, keyword) {
  const word = normalize(keyword).trim();
  if (!word) return [];
  return texts.flatMap((text, i) => {
    const plain = normalize(text);
    return plain.includes(word) && !LATER_PAGE.test(plain) ? [i] : [];
  });
}

/** Nome de arquivo seguro a partir de um título. */
export function fileNameFrom(title, fallback) {
  const clean = String(title || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  return clean || fallback;
}

/** Torna os nomes únicos: "Nota", "Nota (2)", "Nota (3)". */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count === 1 ? name : `${name} (${count})`;
  });
}
