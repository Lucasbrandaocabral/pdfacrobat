// Configuração do PDF.js (motor de leitura e renderização).
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
// O componente de visualização do PDF.js lê a biblioteca de globalThis.
globalThis.pdfjsLib = pdfjsLib;
const viewer = await import("pdfjs-dist/web/pdf_viewer.mjs");

export { pdfjsLib };
export const { EventBus, PDFLinkService, PDFFindController, PDFViewer, LinkTarget } = viewer;
export const { AnnotationEditorType, AnnotationEditorParamsType, PermissionFlag } = pdfjsLib;

export const LOAD_OPTIONS = {
  cMapUrl: "./pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "./pdfjs/standard_fonts/",
  isEvalSupported: false,
};

/**
 * Carrega bytes como documento PDF.js. `getDocument` transfere o buffer para o
 * worker, então sempre passamos uma cópia. `onPassword(incorrect)` deve
 * devolver a senha ou null para cancelar.
 */
export async function loadPdf(bytes, { password, onPassword } = {}) {
  const task = pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes.slice(), password: password ?? undefined });
  let usedPassword = password ?? null;
  if (onPassword) {
    task.onPassword = async (update, reason) => {
      const answer = await onPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
      if (answer === null) task.destroy();
      else {
        usedPassword = answer;
        update(answer);
      }
    };
  }
  const doc = await task.promise;
  return { doc, password: usedPassword };
}

/** Itens de texto de uma página com caixa delimitadora em coordenadas do PDF. */
export async function getTextItems(page) {
  const content = await page.getTextContent({ includeMarkedContent: false });
  const items = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b);
    const style = content.styles[item.fontName] || {};
    // Fontes Type3 (comuns em PDFs do Canva) vêm sem essas medidas (NaN).
    const ascent = style.ascent > 0 && style.ascent < 2 ? style.ascent : 0.8;
    const descent = style.descent <= 0 && style.descent > -1 ? style.descent : -0.2;
    const angle = Math.atan2(b, a);
    const width = item.width;
    // Caixa no espaço do texto (sem rotação) a partir da linha de base.
    const local = [
      [0, descent * size],
      [width, descent * size],
      [width, ascent * size],
      [0, ascent * size],
    ];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const pts = local.map(([x, y]) => [e + x * cos - y * sin, f + x * sin + y * cos]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    items.push({
      str: item.str,
      fontName: item.fontName,
      fontFamily: style.fontFamily || "sans-serif",
      size,
      angle,
      origin: [e, f],
      width,
      ascent,
      descent,
      rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      hasEOL: item.hasEOL,
    });
  }
  return items;
}

/** Nome real da fonte (ex.: "ABCDEF+Calibri-Bold") para inferir negrito/itálico. */
export function fontRealName(page, fontName) {
  return fontInfo(page, fontName).name;
}

/**
 * O que o PDF.js sabe da fonte: nome real e, quando ela foi carregada no
 * navegador para desenhar a página, o nome da família no CSS (`face`).
 */
export function fontInfo(page, fontName) {
  try {
    const font = page.commonObjs.get(fontName);
    const usable = font && !font.isType3Font && !font.missingFile && font.loadedName;
    return { name: font?.name || "", face: usable ? font.loadedName : null };
  } catch {
    return { name: "", face: null };
  }
}
