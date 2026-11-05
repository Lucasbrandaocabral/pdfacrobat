// Configuração do PDF.js (motor de leitura e renderização).
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
// O componente de visualização do PDF.js lê a biblioteca de globalThis.
globalThis.pdfjsLib = pdfjsLib;
const viewer = await import("pdfjs-dist/web/pdf_viewer.mjs");

export { pdfjsLib };
export const { EventBus, PDFLinkService, PDFFindController, PDFViewer, LinkTarget } = viewer;
export const { AnnotationEditorType, AnnotationEditorParamsType, PermissionFlag, PDFWorker } = pdfjsLib;

export const LOAD_OPTIONS = {
  cMapUrl: "./pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "./pdfjs/standard_fonts/",
  isEvalSupported: false,
};

/**
 * Carrega bytes como documento PDF.js. `getDocument` transfere o buffer para o
 * worker, então sempre passamos uma cópia. `onPassword(incorrect)` deve
 * devolver a senha ou null para cancelar. `worker`: um PDFWorker para
 * reaproveitar; sem ele, o documento ganha um worker só dele.
 */
export async function loadPdf(bytes, { password, onPassword, worker } = {}) {
  const task = pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes.slice(), password: password ?? undefined, worker });
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

const spaceChecks = new Map();

/**
 * Das fontes carregadas pelo PDF.js (`faces`, nomes no CSS), as que desenham o
 * espaço como o quadrado de "letra que falta": a fonte do PDF diz ter o espaço,
 * mas o desenho dele não veio no arquivo (comum quando o PDF posiciona cada
 * palavra sem desenhar os espaços). Um espaço de verdade não deixa tinta.
 */
export async function brokenSpaceFaces(faces) {
  const results = await Promise.all(
    faces.map((face) => {
      if (!spaceChecks.has(face)) spaceChecks.set(face, inkOfSpace(face));
      return spaceChecks.get(face).then((broken) => broken && face);
    }),
  );
  return new Set(results.filter(Boolean));
}

async function inkOfSpace(face) {
  const font = `64px "${face}", monospace`;
  try {
    await document.fonts.load(font, " ");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.font = font;
    ctx.fillText(" \u00a0", 8, 72);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
  } catch {
    // Sem como medir: fica como está.
  }
  return false;
}
