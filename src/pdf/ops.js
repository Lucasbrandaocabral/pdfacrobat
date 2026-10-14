// Operações estruturais sobre o documento (páginas, combinação, extração),
// feitas com pdf-lib num PDFDocument já carregado.
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { UserError } from "../ui.js";
import { isolatePage } from "./content.js";

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
      const image = /\.png$/i.test(file.name) ? await doc.embedPng(file.data) : await doc.embedJpg(file.data);
      // Ajusta a imagem a uma página A4 mantendo a proporção.
      const scale = Math.min(595.28 / image.width, 841.89 / image.height, 1);
      const w = Math.max(image.width * scale, 1);
      const h = Math.max(image.height * scale, 1);
      const page = doc.insertPage(index++, [w, h]);
      page.drawImage(image, { x: 0, y: 0, width: w, height: h });
    } else {
      const src = await loadSource(file);
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const page of pages) doc.insertPage(index++, page);
    }
  }
  return index - at;
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
  doc.removePage(from);
  // O removePage do pdf-lib também apaga o objeto da página: sem devolvê-lo,
  // a página reinserida apontaria para o nada e o PDF ficaria quebrado (o
  // leitor mostrava só uma página em branco).
  doc.context.assign(page.ref, page.node);
  doc.insertPage(to, page);
}

export function insertBlankPage(doc, at) {
  const ref = doc.getPage(Math.min(at, doc.getPageCount() - 1));
  const { width, height } = ref.getSize();
  doc.insertPage(at, [width, height]);
}

/** Novo PDF só com as páginas indicadas. */
export async function extractPages(doc, indices) {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

/** Divide em vários PDFs: `groups` é uma lista de listas de índices. */
export async function splitDocument(doc, groups) {
  const results = [];
  for (const indices of groups) results.push({ indices, bytes: await extractPages(doc, indices) });
  return results;
}

/** Cria um PDF novo combinando PDFs e imagens na ordem dada. */
export async function combineFiles(files) {
  const doc = await PDFDocument.create();
  await insertFiles(doc, files);
  return doc.save();
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
