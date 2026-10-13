// Marcas do "Preencher e assinar" (✓, ✗, ● e a data), desenhadas no conteúdo
// da página, em pé como aparecem na tela mesmo em páginas giradas.
import { LineCapStyle, StandardFonts, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb } from "@cantoo/pdf-lib";
import { isolatePage } from "./content.js";

export const MARKS = {
  check: { label: "Marca de seleção" },
  cross: { label: "Cruz" },
  dot: { label: "Ponto" },
  date: { label: "Data" },
};

export function today() {
  return new Date().toLocaleDateString("pt-BR");
}

/**
 * Desenha a marca `kind` centrada em `center` (coordenadas do PDF). `size`, em
 * pontos, é o lado do quadrado da marca ou o tamanho da letra da data;
 * `rotation`, o giro da página.
 */
export async function drawMark(doc, { pageIndex, kind, center, size, color, rotation, text = today() }) {
  const page = doc.getPage(pageIndex);
  isolatePage(doc, page);
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ink = rgb(...color);
  const font = kind === "date" ? await doc.embedFont(StandardFonts.Helvetica) : null;
  // Sistema local: origem no centro, x para a direita e y para cima na tela.
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(cos, sin, -sin, cos, center[0], center[1]));
  const s = size;
  const stroke = { borderColor: ink, borderWidth: Math.max(0.8, s * 0.12), borderLineCap: LineCapStyle.Round };
  // Caminhos em coordenadas SVG (y para baixo), dentro de um quadrado de lado `size`.
  if (kind === "check") {
    page.drawSvgPath(`M ${-0.38 * s} 0 L ${-0.1 * s} ${0.3 * s} L ${0.4 * s} ${-0.36 * s}`, { x: 0, y: 0, ...stroke });
  } else if (kind === "cross") {
    page.drawSvgPath(`M ${-0.32 * s} ${-0.32 * s} L ${0.32 * s} ${0.32 * s} M ${0.32 * s} ${-0.32 * s} L ${-0.32 * s} ${0.32 * s}`, {
      x: 0,
      y: 0,
      ...stroke,
    });
  } else if (kind === "dot") {
    page.drawCircle({ x: 0, y: 0, size: s * 0.2, color: ink });
  } else {
    const width = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: -width / 2, y: -size * 0.35, size, font, color: ink });
  }
  page.pushOperators(popGraphicsState());
}
