// Edição de texto existente: cobre o trecho original com a cor de fundo e
// escreve o novo texto no mesmo lugar, com tamanho e estilo parecidos.
import { StandardFonts, radians, rgb } from "@cantoo/pdf-lib";
import { isolatePage } from "./content.js";

const FAMILIES = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

export function fontStyle(fontFamily, realName = "") {
  const name = `${fontFamily} ${realName}`;
  const family = /mono|courier|consol/i.test(name) ? "mono" : /serif|times|georgia|garamond|cambria|book/i.test(name) && !/sans/i.test(name) ? "serif" : "sans";
  return {
    family,
    bold: /bold|black|heavy|semibold|demi/i.test(realName),
    italic: /italic|oblique/i.test(realName),
  };
}

export function pickFont({ family = "sans", bold = false, italic = false }) {
  return FAMILIES[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

/** Troca caracteres que a fonte padrão não consegue escrever. */
export function encodable(text, font) {
  const supported = new Set(font.getCharacterSet());
  return [...text].map((ch) => (supported.has(ch.codePointAt(0)) ? ch : "?")).join("");
}

/**
 * `item` vem de getTextItems (rect, origin, size, angle). `bg` e `color` são
 * [r, g, b] de 0 a 1. Texto vazio apenas apaga o trecho.
 */
export async function replaceText(doc, pageIndex, { item, text, bg, color, style }) {
  const page = doc.getPage(pageIndex);
  isolatePage(doc, page);
  const [x0, y0, x1, y1] = item.rect;
  const pad = Math.max(0.6, item.size * 0.06);
  page.drawRectangle({ x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad, color: rgb(...bg) });
  if (!text.trim()) return;
  const font = await doc.embedFont(pickFont(style));
  page.drawText(encodable(text, font), {
    x: item.origin[0],
    y: item.origin[1],
    size: item.size,
    font,
    color: rgb(...color),
    rotate: radians(item.angle),
  });
}
