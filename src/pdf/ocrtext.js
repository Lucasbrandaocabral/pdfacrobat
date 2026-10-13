// Camada de texto invisível (resultado do OCR) sobre a página: o texto não
// aparece, mas pode ser pesquisado, selecionado e copiado.
import {
  StandardFonts,
  TextRenderingMode,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
} from "@cantoo/pdf-lib";
import { isolatePage } from "./content.js";
import { encodable } from "./textedit.js";

/**
 * `words` = [{ text, origin: [x, y], width, height }] em coordenadas do PDF,
 * com `origin` no canto inferior esquerdo do texto como aparece na tela.
 * `rotation` é a rotação de exibição da página.
 */
export async function addInvisibleText(doc, pageIndex, words, rotation = 0) {
  if (!words.length) return 0;
  const page = doc.getPage(pageIndex);
  isolatePage(doc, page);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const key = page.node.newFontDictionary("FOCR", font.ref);
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ops = [beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  let count = 0;
  for (const word of words) {
    const text = encodable(word.text, font).trim();
    if (!text || word.width <= 0 || word.height <= 0) continue;
    const size = Math.max(1, word.height * 0.9);
    const natural = font.widthOfTextAtSize(text, size);
    if (!natural) continue;
    const stretch = word.width / natural;
    // Sobe a linha de base acima das pernas das letras (g, p, q).
    const lift = word.height * 0.18;
    ops.push(
      setFontAndSize(key, size),
      setTextMatrix(stretch * cos, stretch * sin, -sin, cos, word.origin[0] - sin * lift, word.origin[1] + cos * lift),
      showText(font.encodeText(text)),
    );
    count++;
  }
  ops.push(endText());
  page.pushOperators(...ops);
  return count;
}
