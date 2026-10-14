// Fontes do Google Fonts que vêm com o app (catálogo em fonts.json, arquivos
// em public/fonts, gerados por scripts/build-fonts.py). Carregadas só quando
// usadas: no navegador para mostrar o texto e no PDF para escrever com elas.
import catalog from "./fonts.json";

export const FONTS = catalog.fonts;
export const DEFAULT_FONT = "arimo";

export const CATEGORIES = {
  sans: "Sem serifa",
  serif: "Com serifa",
  display: "Títulos",
  handwriting: "Manuscritas",
  mono: "Monoespaçadas",
};

const byId = new Map(FONTS.map((f) => [f.id, f]));
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const byKey = new Map(FONTS.map((f) => [normalize(f.family), f]));

export function fontById(id) {
  return byId.get(id) || byId.get(DEFAULT_FONT);
}

const fileUrl = (id, weight) => new URL(`fonts/${id}-${weight}.ttf`, document.baseURI).href;
const realWeight = (font, bold) => (bold && font.bold ? 700 : 400);

/** Nome da família no CSS (próprio do app, para não colidir com fontes do sistema). */
export function cssFamily(id) {
  return `"pdfa-${fontById(id).id}"`;
}

/**
 * Família só com um peso (carregada com `loadFontFace(id, bold, { exact: true })`):
 * serve de reserva para outra fonte sem o navegador engrossar a letra por conta própria.
 */
export function exactFamily(id, bold = false) {
  const font = fontById(id);
  return `"pdfa-${font.id}-${realWeight(font, bold)}"`;
}

const faces = new Map();
/** Carrega a fonte no navegador; resolve quando ela já pode ser desenhada. */
export function loadFontFace(id, bold = false, { exact = false } = {}) {
  const font = fontById(id);
  const weight = realWeight(font, bold);
  const family = exact ? `pdfa-${font.id}-${weight}` : `pdfa-${font.id}`;
  const key = `${family}/${weight}`;
  if (!faces.has(key)) {
    const face = new FontFace(family, `url(${fileUrl(font.id, weight)})`, exact ? {} : { weight: String(weight) });
    faces.set(
      key,
      face.load().then(
        (loaded) => document.fonts.add(loaded),
        (err) => {
          faces.delete(key);
          throw err;
        },
      ),
    );
  }
  return faces.get(key);
}

const files = new Map();
/** Bytes do arquivo .ttf para embutir no PDF. */
export function fontBytes(id, bold = false) {
  const font = fontById(id);
  const weight = realWeight(font, bold);
  const key = `${font.id}-${weight}`;
  if (!files.has(key)) {
    const promise = fetch(fileUrl(font.id, weight)).then((response) => {
      if (!response.ok) throw new Error(`Fonte ${font.family} indisponível (${response.status}).`);
      return response.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    });
    promise.catch(() => files.delete(key));
    files.set(key, promise);
  }
  return files.get(key);
}

/** O catálogo tem negrito de verdade para essa fonte? (sem ele, o app engrossa o traço) */
export function hasBold(id) {
  return fontById(id).bold;
}

/** Nome PostScript do arquivo (como o build-fonts.py grava), usado no PDF. */
function postscriptName(font, bold) {
  return `${font.family.replace(/[^A-Za-z0-9]/g, "")}-${bold ? "Bold" : "Regular"}`;
}

/** O que o PDF precisa para escrever com a fonte: bytes, nome e se o negrito é de verdade. */
export async function catalogFont(id, bold = false) {
  const font = fontById(id);
  const real = bold && font.bold;
  return { bytes: await fontBytes(font.id, real), name: postscriptName(font, real), bold: real };
}

const WEIGHT_SUFFIX = /(thin|hairline|extralight|ultralight|light|regular|book|normal|medium|semibold|demibold|extrabold|ultrabold|bold|black|heavy|italic|oblique)+$/;

/**
 * A fonte do catálogo para o nome de uma fonte do PDF (ex.: "ABCDEF+Montserrat-Bold",
 * "Arial-BoldMT", "TimesNewRomanPSMT"), com negrito e itálico. `exact` diz se é a
 * mesma família (e não uma parecida, como a Arimo no lugar da Arial). null se não houver.
 */
export function matchFont(pdfName) {
  if (!pdfName) return null;
  const name = pdfName.replace(/^[A-Z]{6}\+/, "").replace(/-\d+$/, "");
  const [familyPart, ...rest] = name.split(/[-,]/);
  const style = rest.join(" ") || familyPart;
  // Sem os sufixos de fabricante (MT, PS) e de tamanho ótico ("9pt", "12pt").
  const base = normalize(familyPart).replace(/(psmt|mt|ps)$/, "").replace(/\d+pt/g, "");
  let font = null;
  let exact = false;
  for (const key of [base, base.replace(WEIGHT_SUFFIX, "")]) {
    if (byKey.has(key)) {
      font = byKey.get(key);
      exact = true;
      break;
    }
    if (catalog.aliases[key]) {
      font = byId.get(catalog.aliases[key]);
      break;
    }
  }
  if (!font) return null;
  return {
    id: font.id,
    exact,
    bold: /bold|black|heavy|semibold|demi/i.test(style),
    italic: /italic|oblique/i.test(name),
  };
}

/** Fonte parecida para um texto cuja fonte não está no catálogo. */
export function fallbackFont({ family = "sans", bold = false, italic = false } = {}) {
  return { id: { sans: "arimo", serif: "tinos", mono: "cousine" }[family] || DEFAULT_FONT, exact: false, bold, italic };
}

const RECENT_KEY = "fontes-recentes";

/** Fontes usadas por último (ids), da mais recente para a mais antiga. */
export function recentFonts() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(list) ? list.filter((id) => byId.has(id)) : [];
  } catch {
    return [];
  }
}

export function rememberFont(id) {
  if (!byId.has(id)) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentFonts().filter((f) => f !== id)].slice(0, 6)));
  } catch {
    // Sem armazenamento: só não lembra.
  }
}
