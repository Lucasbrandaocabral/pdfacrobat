// Os pontos (valores de cor) das imagens do PDF, sem compressão: para tarjar
// pedaços de uma imagem e para recomprimi-la.
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "@cantoo/pdf-lib";

const key = (name) => PDFName.of(name);
const nameOf = (obj) => (obj instanceof PDFName ? obj.decodeText() : "");
const num = (obj) => (typeof obj?.asNumber === "function" ? obj.asNumber() : undefined);

const DECODABLE = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);

export function filtersOf(dict) {
  const filter = dict.lookup(key("Filter"));
  if (filter instanceof PDFArray) return filter.asArray().map((_, i) => nameOf(filter.lookup(i)));
  return filter ? [nameOf(filter)] : [];
}

/** Quantos valores tem cada ponto no espaço de cor; 0 quando não dá para saber. */
export function colorComponents(doc, space) {
  const value = space instanceof PDFRef ? doc.context.lookup(space) : space;
  if (value instanceof PDFName) return { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4, CalGray: 1, CalRGB: 3 }[value.decodeText()] || 0;
  if (!(value instanceof PDFArray)) return 0;
  const family = nameOf(value.lookup(0));
  if (family === "ICCBased") return num(value.lookup(1)?.dict?.lookup(key("N"))) || 0;
  if (family === "Indexed" || family === "Separation" || family === "CalGray") return 1;
  if (family === "CalRGB" || family === "Lab") return 3;
  if (family === "DeviceN") {
    const names = value.lookup(1);
    return names instanceof PDFArray ? names.size() : 0;
  }
  return 0;
}

/** Desfaz o previsor PNG (cada linha com o seu filtro). */
function unPng(data, colors, bpc, columns) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const length = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (length + 1));
  const out = new Uint8Array(rows * length);
  let prev = new Uint8Array(length);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (length + 1)];
    const line = data.subarray(r * (length + 1) + 1, (r + 1) * (length + 1));
    const cur = out.subarray(r * length, (r + 1) * length);
    for (let i = 0; i < length; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (type !== 0) return null;
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

/** Desfaz o previsor TIFF (só com 8 bits por valor). */
function unTiff(data, colors, columns) {
  const length = colors * columns;
  const out = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at++) {
    const i = at % length;
    out[at] = (data[at] + (i >= colors ? out[at - colors] : 0)) & 0xff;
  }
  return out;
}

/** Os valores dos pontos, sem compressão, linha a linha; null num formato que não dá para editar aqui. */
export function decodeSamples(stream) {
  const filters = filtersOf(stream.dict);
  if (!(stream instanceof PDFRawStream) || filters.some((f) => !DECODABLE.has(f))) return null;
  let data;
  try {
    data = decodePDFRawStream(stream).decode();
  } catch {
    return null;
  }
  const parms = stream.dict.lookup(key("DecodeParms"));
  for (let i = 0; i < filters.length; i++) {
    const p = parms instanceof PDFArray ? parms.lookup(i) : filters.length === 1 ? parms : null;
    const predictor = p instanceof PDFDict ? (num(p.lookup(key("Predictor"))) ?? 1) : 1;
    if (predictor <= 1) continue;
    // Previsor no meio da cadeia de filtros: raro, e o pdf-lib não o desfaz.
    if (i !== filters.length - 1) return null;
    const colors = num(p.lookup(key("Colors"))) ?? 1;
    const bpc = num(p.lookup(key("BitsPerComponent"))) ?? 8;
    const columns = num(p.lookup(key("Columns"))) ?? 1;
    data = predictor >= 10 ? unPng(data, colors, bpc, columns) : predictor === 2 && bpc === 8 ? unTiff(data, colors, columns) : null;
    if (!data) return null;
  }
  return data;
}
