// Operações estruturais sobre o arquivo PDF (equivalente às camadas PD/Cos
// do SDK do Acrobat), feitas com pdf-lib diretamente nos bytes do documento.
import { PDFDocument, degrees } from "pdf-lib";

export class ProtectedPdfError extends Error {}

async function load(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(err.message)) {
      throw new ProtectedPdfError("Este documento é protegido por senha e não pode ser reorganizado.");
    }
    throw err;
  }
}

export function isImage(name) {
  return /\.(png|jpe?g)$/i.test(name);
}

/** Acrescenta arquivos (PDF ou imagem) a `doc`, a partir da posição `at`. */
async function appendFiles(doc, files, at = doc.getPageCount()) {
  let index = at;
  for (const file of files) {
    if (isImage(file.name)) {
      const image = /\.png$/i.test(file.name) ? await doc.embedPng(file.data) : await doc.embedJpg(file.data);
      // Ajusta a imagem a uma página A4 mantendo a proporção.
      const maxW = 595.28;
      const maxH = 841.89;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      const page = doc.insertPage(index++, [Math.max(w, 1), Math.max(h, 1)]);
      page.drawImage(image, { x: 0, y: 0, width: w, height: h });
    } else {
      const src = await load(file.data);
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const page of pages) doc.insertPage(index++, page);
    }
  }
  return index - at;
}

async function edit(bytes, fn) {
  const doc = await load(bytes);
  const result = await fn(doc);
  return { bytes: await doc.save(), result };
}

export function rotatePages(bytes, pageIndices, delta) {
  return edit(bytes, (doc) => {
    for (const i of pageIndices) {
      const page = doc.getPage(i);
      const angle = (((page.getRotation().angle + delta) % 360) + 360) % 360;
      page.setRotation(degrees(angle));
    }
  });
}

export function deletePages(bytes, pageIndices) {
  return edit(bytes, (doc) => {
    if (pageIndices.length >= doc.getPageCount()) {
      throw new Error("Um PDF precisa ter pelo menos uma página.");
    }
    for (const i of [...pageIndices].sort((a, b) => b - a)) doc.removePage(i);
  });
}

export function movePage(bytes, from, to) {
  return edit(bytes, (doc) => {
    const page = doc.getPage(from);
    doc.removePage(from);
    doc.insertPage(to, page);
  });
}

export function insertBlankPage(bytes, at) {
  return edit(bytes, (doc) => {
    const ref = doc.getPage(Math.min(at, doc.getPageCount() - 1));
    const { width, height } = ref.getSize();
    doc.insertPage(at, [width, height]);
  });
}

export function insertFiles(bytes, files, at) {
  return edit(bytes, (doc) => appendFiles(doc, files, at));
}

export async function extractPages(bytes, pageIndices) {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, pageIndices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

/** Cria um PDF novo combinando PDFs e imagens na ordem dada. */
export async function combineFiles(files) {
  const doc = await PDFDocument.create();
  await appendFiles(doc, files);
  return doc.save();
}

/**
 * Carimba uma imagem PNG (assinatura) na página. `origin` é o canto inferior
 * esquerdo em coordenadas do PDF; `rotation` é a rotação de exibição da página,
 * usada para que a assinatura apareça "em pé" mesmo em páginas giradas.
 */
export function stampImage(bytes, { pageIndex, pngBytes, origin, width, height, rotation }) {
  return edit(bytes, async (doc) => {
    const page = doc.getPage(pageIndex);
    const image = await doc.embedPng(pngBytes);
    page.drawImage(image, {
      x: origin[0],
      y: origin[1],
      width,
      height,
      rotate: degrees(rotation),
    });
  });
}
