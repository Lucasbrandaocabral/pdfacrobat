// Compressão: recomprime as imagens em JPEG (reduzindo a resolução das muito
// grandes) e compacta fluxos que estavam sem compressão.
import { PDFName, PDFNumber, PDFRawStream, extractImageBytes } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";

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

async function recompress(stream, level) {
  const { dict } = stream;
  if (dict.lookup(name("ImageMask"))?.asBoolean?.()) return null;
  if (dict.lookup(name("Decode"))) return null;
  const bpc = lookupNumber(dict, "BitsPerComponent");
  if (bpc && bpc !== 8) return null;
  const smask = dict.lookup(name("SMask"));
  if (smask?.dict?.lookup?.(name("Matte"))) return null;
  const width = lookupNumber(dict, "Width") || 0;
  const height = lookupNumber(dict, "Height") || 0;
  if (width * height < 160 * 160 || stream.contents.length < 24 * 1024) return null;
  let extracted;
  try {
    extracted = extractImageBytes(stream);
  } catch {
    return null;
  }
  if (!extracted) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([extracted.bytes], { type: extracted.mimeType }));
  } catch {
    return null;
  }
  try {
    return await toJpeg(bitmap, level);
  } finally {
    bitmap.close();
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

  let changed = 0;
  for (const [k, [ref, stream]] of images.entries()) {
    onProgress?.(k + 1, images.length);
    const result = await recompress(stream, level);
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
