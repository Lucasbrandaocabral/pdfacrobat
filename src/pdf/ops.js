// Operações estruturais sobre o documento (páginas, combinação, extração),
// feitas com pdf-lib num PDFDocument já carregado.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFObjectCopier, PDFPage, PDFRef, PDFStream, degrees } from "@cantoo/pdf-lib";
import { UserError } from "../ui.js";
import { isolatePage } from "./content.js";
import { saveFromEdit } from "./security.js";

const key = (name) => PDFName.of(name);

export function isImage(name) {
  return /\.(png|jpe?g)$/i.test(name);
}

async function loadSource(file) {
  try {
    return await PDFDocument.load(file.data, { updateMetadata: false });
  } catch (err) {
    if (/encrypt|password/i.test(err.message)) {
      throw new UserError(`"${file.name}" é protegido por senha. Remova a senha dele antes de combinar.`);
    }
    throw new UserError(`Não foi possível ler "${file.name}": ${err.message}`);
  }
}

/** Insere arquivos (PDF ou imagem) em `doc` a partir da posição `at`. */
export async function insertFiles(doc, files, at = doc.getPageCount()) {
  let index = at;
  for (const file of files) {
    if (isImage(file.name)) {
      const png = /\.png$/i.test(file.name);
      const image = png ? await doc.embedPng(file.data) : await doc.embedJpg(file.data);
      // Foto de celular: o JPEG guarda a imagem deitada e diz no EXIF como mostrá-la.
      const turn = png ? 0 : jpegRotation(file.data);
      const width = turn % 180 ? image.height : image.width;
      const height = turn % 180 ? image.width : image.height;
      // Ajusta a imagem a uma página A4 mantendo a proporção.
      const scale = Math.min(595.28 / width, 841.89 / height, 1);
      const w = Math.max(width * scale, 1);
      const h = Math.max(height * scale, 1);
      const page = insertPage(doc, index++, [w, h]);
      drawImageInBox(page, image, [0, 0, w, h], -turn);
    } else {
      const src = await loadSource(file);
      const pages = await copyPagesOnly(doc, src, src.getPageIndices());
      for (const page of pages) insertPage(doc, index++, page);
    }
  }
  return index - at;
}

/**
 * Cópias das páginas `indices` de `src` em `out`, na ordem (ainda fora da
 * árvore de páginas). O que aponta para uma delas (links entre elas, a página
 * de cada comentário) passa a apontar para a cópia. O que aponta para as outras
 * páginas (links, campos, artigos) deixa de apontar: o pdf-lib copiaria cada
 * uma inteira, com o conteúdo, para dentro do arquivo novo.
 */
async function copyPagesOnly(out, src, indices) {
  await src.flush();
  const copier = PDFObjectCopier.for(src.context, out.context);
  const source = src.getPages();
  const refs = indices.map(() => out.context.nextRef());
  indices.forEach((i, k) => copier.traversedObjects.set(source[i].ref, refs[k]));
  const pages = indices.map((i, k) => {
    const node = copier.copy(source[i].node);
    out.context.assign(refs[k], node);
    return PDFPage.of(node, refs[k], out);
  });
  cutOtherPages(out.context, pages);
  return pages;
}

function cutOtherPages(context, pages) {
  const kept = new Set(pages.map((page) => page.ref));
  const other = (value) => value instanceof PDFRef && !kept.has(value) && context.lookup(value)?.get?.(key("Type")) === key("Page");
  const seen = new Set();
  const stack = pages.map((page) => page.node);
  const follow = (value) => {
    const target = value instanceof PDFRef ? context.lookup(value) : value;
    if ((target instanceof PDFDict || target instanceof PDFArray || target instanceof PDFStream) && !seen.has(target)) stack.push(target);
  };
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    if (node instanceof PDFStream) follow(node.dict);
    else if (node instanceof PDFDict) {
      for (const [name, value] of node.entries()) {
        if (other(value)) node.set(name, PDFNull);
        else follow(value);
      }
    } else if (node instanceof PDFArray) {
      for (let i = 0; i < node.size(); i++) {
        if (other(node.get(i))) node.set(i, PDFNull);
        else follow(node.get(i));
      }
    }
  }
  // Links que iam para essas páginas ficariam sem destino.
  for (const page of pages) {
    const annots = page.node.lookup(key("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict) || annot.get(key("Subtype")) !== key("Link")) continue;
      const action = annot.lookup(key("A"));
      const dest = annot.lookup(key("Dest")) ?? (action instanceof PDFDict ? action.lookup(key("D")) : null);
      if (dest instanceof PDFArray && dest.get(0) === PDFNull) annots.remove(i);
    }
  }
}

/**
 * O que a página herda da árvore de páginas (recursos, tamanho, recorte, giro)
 * passa a ficar nela mesma: num lugar novo da árvore, ela herdaria os valores
 * de outro ramo.
 */
function pinInherited(page) {
  for (const name of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
    if (page.node.get(key(name))) continue;
    const value = page.node.getInheritableAttribute(key(name));
    if (value) page.node.set(key(name), value);
  }
}

/** Põe a página na posição `at` sem que ela herde o giro e o recorte do ramo em que entrou. */
function insertPage(doc, at, page) {
  const inserted = doc.insertPage(at, page);
  const { node } = inserted;
  if (!node.get(key("Rotate")) && node.getInheritableAttribute(key("Rotate"))) node.set(key("Rotate"), PDFNumber.of(0));
  if (!node.get(key("CropBox")) && node.getInheritableAttribute(key("CropBox"))) node.set(key("CropBox"), node.MediaBox().clone());
  return inserted;
}

export function rotatePages(doc, indices, delta) {
  for (const i of indices) {
    const page = doc.getPage(i);
    page.setRotation(degrees((((page.getRotation().angle + delta) % 360) + 360) % 360));
  }
}

export function deletePages(doc, indices) {
  if (indices.length >= doc.getPageCount()) throw new UserError("Um PDF precisa ter pelo menos uma página.");
  for (const i of [...indices].sort((a, b) => b - a)) doc.removePage(i);
}

export function movePage(doc, from, to) {
  const page = doc.getPage(from);
  pinInherited(page);
  doc.removePage(from);
  // O removePage do pdf-lib também apaga o objeto da página: sem devolvê-lo,
  // a página reinserida apontaria para o nada e o PDF ficaria quebrado (o
  // leitor mostrava só uma página em branco).
  doc.context.assign(page.ref, page.node);
  insertPage(doc, to, page);
}

export function insertBlankPage(doc, at) {
  const ref = doc.getPage(Math.min(at, doc.getPageCount() - 1));
  const { width, height } = ref.getSize();
  insertPage(doc, at, [width, height]);
}

/**
 * Novo PDF só com as páginas indicadas. Com `security` (documento protegido),
 * ele sai com a mesma proteção: mesmas senhas e restrições.
 */
export async function extractPages(doc, indices, security = null) {
  const out = await PDFDocument.create();
  const pages = await copyPagesOnly(out, doc, indices);
  pages.forEach((p) => out.addPage(p));
  return saveFromEdit(out, security);
}

/** Divide em vários PDFs: `groups` é uma lista de listas de índices. */
export async function splitDocument(doc, groups, security = null) {
  const results = [];
  for (const indices of groups) results.push({ indices, bytes: await extractPages(doc, indices, security) });
  return results;
}

/** Cria um PDF novo combinando PDFs e imagens na ordem dada. */
export async function combineFiles(files) {
  const doc = await PDFDocument.create();
  await insertFiles(doc, files);
  return doc.save();
}

/**
 * Desenha `image` no retângulo `box` [x0, y0, x1, y1] (coordenadas do PDF),
 * centralizada e sem distorcer, girada `rotation` graus (anti-horário; múltiplo
 * de 90). Com a rotação de exibição da página, ela aparece em pé na tela.
 */
export function drawImageInBox(page, image, [x0, y0, x1, y1], rotation = 0) {
  const turn = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  const sideways = turn % 180 !== 0;
  const scale = Math.min((x1 - x0) / (sideways ? image.height : image.width), (y1 - y0) / (sideways ? image.width : image.height));
  const w = image.width * scale;
  const h = image.height * scale;
  // O espaço que ela ocupa depois de girada, centralizado na caixa.
  const fw = sideways ? h : w;
  const fh = sideways ? w : h;
  const left = x0 + (x1 - x0 - fw) / 2;
  const bottom = y0 + (y1 - y0 - fh) / 2;
  // O canto em volta do qual o pdf-lib gira a imagem.
  const [x, y] = { 0: [left, bottom], 90: [left + fw, bottom], 180: [left + fw, bottom + fh], 270: [left, bottom + fh] }[turn];
  page.drawImage(image, { x, y, width: w, height: h, rotate: degrees(turn) });
}

/** Quantos graus (horário) a foto JPEG pede para girar ao mostrar (EXIF Orientation); 0 sem a informação. */
export function jpegRotation(bytes) {
  const byte = (at) => (at < bytes.length ? bytes[at] : 0);
  let at = 2;
  while (at + 10 < bytes.length && byte(at) === 0xff) {
    const marker = byte(at + 1);
    const length = (byte(at + 2) << 8) | byte(at + 3);
    if (marker === 0xda || length < 2) break;
    const exif = String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === "Exif\0\0";
    if (marker === 0xe1 && exif) {
      const tiff = at + 10;
      const little = byte(tiff) === 0x49;
      const u16 = (o) => (little ? byte(o) | (byte(o + 1) << 8) : (byte(o) << 8) | byte(o + 1));
      const u32 = (o) => (little ? u16(o) + u16(o + 2) * 65536 : u16(o) * 65536 + u16(o + 2));
      const ifd = tiff + u32(tiff + 4);
      const count = u16(ifd);
      for (let i = 0; i < count && ifd + 14 + i * 12 <= bytes.length; i++) {
        const entry = ifd + 2 + i * 12;
        // Os espelhados (2, 4, 5, 7) giram como os parecidos; espelhar não dá aqui.
        if (u16(entry) === 0x0112) return { 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 }[u16(entry + 8)] || 0;
      }
      return 0;
    }
    at += 2 + length;
  }
  return 0;
}

/**
 * Carimba uma imagem PNG (assinatura) na página. `origin` é o canto inferior
 * esquerdo em coordenadas do PDF; `rotation` é a rotação de exibição da página,
 * para que a imagem apareça "em pé" mesmo em páginas giradas.
 */
export async function drawPngOnPage(doc, { pageIndex, pngBytes, origin, width, height, rotation }) {
  const page = doc.getPage(pageIndex);
  isolatePage(doc, page);
  const image = await doc.embedPng(pngBytes);
  page.drawImage(image, { x: origin[0], y: origin[1], width, height, rotate: degrees(rotation) });
}
