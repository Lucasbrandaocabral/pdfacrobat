// Compressão: recomprime as imagens em JPEG (reduzindo a resolução das muito
// grandes) e compacta fluxos que estavam sem compressão.
import { PDFArray, PDFName, PDFNumber, PDFRawStream, PDFRef } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import { decodeSamples, filtersOf } from "./samples.js";

export const COMPRESSION_LEVELS = {
  low: { quality: 0.85, maxDim: 2400 },
  medium: { quality: 0.72, maxDim: 1700 },
  high: { quality: 0.55, maxDim: 1150 },
};

const name = (value) => PDFName.of(value);

function lookupName(dict, key) {
  return dict.lookup(name(key))?.asString?.() ?? null;
}

function lookupNumber(dict, key) {
  return dict.lookup(name(key))?.asNumber?.() ?? null;
}

async function toJpeg(bitmap, { quality, maxDim }) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

/** Cinza ou RGB: 1 ou 3; outros espaços de cor (CMYK, paleta, cor especial) mudariam as cores. */
function grayOrRgb(doc, dict) {
  const space = doc.context.lookup(dict.get(name("ColorSpace")));
  if (space instanceof PDFName) return { "/DeviceGray": 1, "/CalGray": 1, "/DeviceRGB": 3, "/CalRGB": 3 }[space.asString()] || 0;
  if (space instanceof PDFArray && space.lookup(0) === name("ICCBased")) {
    const n = space.lookup(1)?.dict?.lookup(name("N"))?.asNumber?.();
    return n === 1 || n === 3 ? n : 0;
  }
  if (space instanceof PDFArray) return grayOrRgb(doc, doc.context.obj({ ColorSpace: space.lookup(0) }));
  return 0;
}

/** A imagem pronta para desenhar no canvas (os pontos decodificados, com os previsores desfeitos). */
async function pixels(doc, stream, width, height) {
  const comps = grayOrRgb(doc, stream.dict);
  if (!comps) return null;
  const filters = filtersOf(stream.dict);
  if (filters.length === 1 && filters[0] === "DCTDecode") {
    try {
      return await createImageBitmap(new Blob([stream.contents], { type: "image/jpeg" }));
    } catch {
      return null;
    }
  }
  const samples = decodeSamples(stream);
  if (!samples || samples.length < width * height * comps) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += comps) {
    rgba[i * 4] = samples[j];
    rgba[i * 4 + 1] = samples[comps === 3 ? j + 1 : j];
    rgba[i * 4 + 2] = samples[comps === 3 ? j + 2 : j];
    rgba[i * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

async function recompress(doc, stream, level) {
  const { dict } = stream;
  if (dict.lookup(name("ImageMask"))?.asBoolean?.()) return null;
  if (dict.lookup(name("Decode"))) return null;
  // Transparência por cor exata: com as perdas do JPEG, as cores deixariam de bater.
  if (dict.lookup(name("Mask")) instanceof PDFArray) return null;
  const bpc = lookupNumber(dict, "BitsPerComponent");
  if (bpc && bpc !== 8) return null;
  const smask = dict.lookup(name("SMask"));
  if (smask?.dict?.lookup?.(name("Matte"))) return null;
  const width = lookupNumber(dict, "Width") || 0;
  const height = lookupNumber(dict, "Height") || 0;
  if (width * height < 160 * 160 || stream.contents.length < 24 * 1024) return null;
  const source = await pixels(doc, stream, width, height);
  if (!source) return null;
  try {
    return await toJpeg(source, level);
  } finally {
    source.close?.();
  }
}

/** Comprime o documento no lugar. Retorna quantas imagens mudaram. */
export async function compressDocument(doc, levelKey, onProgress) {
  const level = COMPRESSION_LEVELS[levelKey];
  const { context } = doc;
  const images = [];
  const plain = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const subtype = lookupName(object.dict, "Subtype");
    if (subtype === "/Image") images.push([ref, object]);
    else if (!object.dict.has(name("Filter")) && lookupName(object.dict, "Type") !== "/Metadata" && object.contents.length > 512) {
      plain.push([ref, object]);
    }
  }

  // Máscaras de transparência de outras imagens ficam como estão: viram JPEG
  // colorido e a imagem sumiria.
  const masks = new Set();
  for (const [, stream] of images) {
    for (const key of ["SMask", "Mask"]) {
      const ref = stream.dict.get(name(key));
      if (ref instanceof PDFRef) masks.add(ref);
    }
  }

  let changed = 0;
  for (const [k, [ref, stream]] of images.entries()) {
    onProgress?.(k + 1, images.length);
    if (masks.has(ref)) continue;
    const result = await recompress(doc, stream, level);
    if (!result || result.bytes.length >= stream.contents.length * 0.9) continue;
    const dict = stream.dict.clone(context);
    for (const key of ["Filter", "DecodeParms", "Length", "ColorSpace", "BitsPerComponent", "Decode"]) dict.delete(name(key));
    dict.set(name("Filter"), name("DCTDecode"));
    dict.set(name("ColorSpace"), name("DeviceRGB"));
    dict.set(name("BitsPerComponent"), PDFNumber.of(8));
    dict.set(name("Width"), PDFNumber.of(result.width));
    dict.set(name("Height"), PDFNumber.of(result.height));
    context.assign(ref, PDFRawStream.of(dict, result.bytes));
    changed++;
  }

  for (const [ref, stream] of plain) {
    const dict = stream.dict.clone(context);
    dict.delete(name("Length"));
    dict.set(name("Filter"), name("FlateDecode"));
    context.assign(ref, PDFRawStream.of(dict, zlibSync(stream.contents, { level: 9 })));
  }
  return { images: images.length, changed };
}
