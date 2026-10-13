// Marca d'água e cabeçalho/rodapé (com numeração de páginas). As posições
// são calculadas na página como ela aparece na tela, inclusive se girada.
import { PDFArray, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { isolatePage } from "./content.js";
import { encodable } from "./textedit.js";

/** Converte coordenadas "visuais" (página como exibida) para as do PDF. */
export function visualFrame(page) {
  const { x, y, width, height } = page.getCropBox();
  const r = (((page.getRotation().angle % 360) + 360) % 360);
  const swap = r === 90 || r === 270;
  const toUser = (vx, vy) => {
    switch (r) {
      case 90:
        return [x + width - vy, y + vx];
      case 180:
        return [x + width - vx, y + height - vy];
      case 270:
        return [x + vy, y + height - vx];
      default:
        return [x + vx, y + vy];
    }
  };
  return { W: swap ? height : width, H: swap ? width : height, r, toUser };
}

/** Inverso de frame.toUser: coordenadas do PDF -> visuais. */
export function fromUser(frame, x, y) {
  const [ox, oy] = frame.toUser(0, 0);
  const [ax, ay] = frame.toUser(1, 0);
  const [bx, by] = frame.toUser(0, 1);
  const det = (ax - ox) * (by - oy) - (bx - ox) * (ay - oy);
  const dx = x - ox;
  const dy = y - oy;
  return [(dx * (by - oy) - dy * (bx - ox)) / det, ((ax - ox) * dy - (ay - oy) * dx) / det];
}

function drawVisualText(page, frame, text, { vx, vy, size, font, color, opacity = 1, angle = 0 }) {
  const [x, y] = frame.toUser(vx, vy);
  page.drawText(text, { x, y, size, font, color, opacity, rotate: degrees(frame.r + angle) });
}

/** Move o último conteúdo desenhado pelo pdf-lib para trás do conteúdo da página. */
function sendToBack(page) {
  const contents = page.node.Contents();
  const ref = page.contentStreamRef;
  if (!(contents instanceof PDFArray) || !ref) return;
  const index = contents.indexOf(ref);
  if (index === undefined || index === 0) return;
  contents.remove(index);
  contents.insert(0, ref);
}

export async function addWatermark(doc, { text, size, color, opacity, angle, position, pages, behind }) {
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = encodable(text, font);
  const theta = (angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  for (const i of pages) {
    const page = doc.getPage(i);
    isolatePage(doc, page);
    const frame = visualFrame(page);
    // Reduz a fonte se o texto (já inclinado) não couber na página.
    const width0 = font.widthOfTextAtSize(safe, size);
    const height0 = size * 0.72;
    const extentX0 = Math.abs(cos) * width0 + Math.abs(sin) * height0;
    const extentY0 = Math.abs(sin) * width0 + Math.abs(cos) * height0;
    const fit = Math.min(1, (frame.W * 0.9) / extentX0, (frame.H * 0.9) / extentY0);
    const fontSize = size * fit;
    const tw = width0 * fit;
    const th = height0 * fit;
    const halfY = (Math.abs(sin) * tw + Math.abs(cos) * th) / 2;
    const margin = 36;
    const cx = frame.W / 2;
    const cy = position === "top" ? frame.H - margin - halfY : position === "bottom" ? margin + halfY : frame.H / 2;
    // Origem do texto para que o centro dele fique em (cx, cy).
    const ox = cx - (cos * tw - sin * th) / 2;
    const oy = cy - (sin * tw + cos * th) / 2;
    drawVisualText(page, frame, safe, { vx: ox, vy: oy, size: fontSize, font, color: rgb(...color), opacity, angle });
    if (behind) sendToBack(page);
  }
}

function fillTokens(template, values) {
  return template.replace(/\{(n|total|data|arquivo)\}/gi, (_, key) => values[key.toLowerCase()]);
}

/**
 * `header` e `footer` são [esquerda, centro, direita]. `start` é o número da
 * primeira página do intervalo; `{total}` é o número da última.
 */
export async function addHeaderFooter(doc, { header, footer, size, color, margin, start, pages, fileName }) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const date = new Date().toLocaleDateString("pt-BR");
  const last = start + pages.length - 1;
  pages.forEach((pageIndex, k) => {
    const page = doc.getPage(pageIndex);
    isolatePage(doc, page);
    const frame = visualFrame(page);
    const values = { n: String(start + k), total: String(last), data: date, arquivo: fileName };
    const rows = [
      [header, frame.H - margin - size * 0.75],
      [footer, margin],
    ];
    for (const [parts, vy] of rows) {
      parts.forEach((template, column) => {
        if (!template?.trim()) return;
        const text = encodable(fillTokens(template, values), font);
        const tw = font.widthOfTextAtSize(text, size);
        const vx = column === 0 ? margin : column === 1 ? (frame.W - tw) / 2 : frame.W - margin - tw;
        drawVisualText(page, frame, text, { vx, vy, size, font, color: rgb(...color) });
      });
    }
  });
}
