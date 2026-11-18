// Colar imagem: Ctrl+V (ou "Colar imagem" no botão direito) com uma imagem
// copiada do navegador ("Copiar imagem"), de um print da tela ou de um
// arquivo de imagem copiado no Explorador de Arquivos ou no Finder. A imagem
// entra na página e abre na caixa de imagem, para mover e mudar o tamanho.
import { toast } from "./ui.js";
import * as platform from "./platform.js";
import { jpegRotation } from "./pdf/ops.js";

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** O primeiro arquivo de imagem de um evento de colar (ou null). */
function imageFromEvent(e) {
  const data = e.clipboardData;
  if (!data) return null;
  const files = [...(data.files || [])];
  const items = [...(data.items || [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
  return [...files, ...items].find((file) => /^image\//.test(file.type) || IMAGE_NAME.test(file.name)) ?? null;
}

/** Arquivo do navegador → { name, type, data }. */
async function fromFile(file) {
  const type = file.type || (/\.png$/i.test(file.name) ? "image/png" : "image/jpeg");
  const name = file.name && file.name !== "image.png" ? file.name : `imagem.${type.split("/")[1] || "png"}`;
  return { name, type, data: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * A imagem que está na área de transferência agora, sem um evento de colar
 * (o item do botão direito): no programa de computador pelo Electron (também
 * arquivos copiados no Explorador); no navegador, pela Clipboard API.
 */
export async function readClipboardImage() {
  if (platform.clipboardImage) return platform.clipboardImage();
  if (!navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => /^image\//.test(t));
    if (type) return fromFile(new File([await item.getType(type)], "", { type }));
  }
  return null;
}

/**
 * Liga o Ctrl+V de imagens. `insert(image)` põe a imagem no documento aberto
 * (ou cria um PDF com ela, se não há nenhum).
 */
export function setupImagePaste(insert) {
  document.addEventListener("paste", async (e) => {
    // Colar em campos e na caixa de texto, e o que os objetos já colaram, não é com a gente.
    if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
    if (e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
    const file = imageFromEvent(e);
    if (file) {
      e.preventDefault();
      return insert(await fromFile(file));
    }
    // No programa de computador, um arquivo copiado no Explorador nem sempre
    // chega no evento: o Electron lê da área de transferência do sistema.
    const types = [...(e.clipboardData?.types || [])];
    if (!platform.clipboardImage || (types.length && !types.includes("Files"))) return;
    const image = await platform.clipboardImage().catch(() => null);
    if (image) insert(image);
  });
}

/**
 * A imagem pronta para o PDF: PNG ou JPEG (as outras, como WebP e GIF, viram
 * PNG), com o tamanho em pixels como aparece na tela e o giro do JPEG (EXIF).
 * Devolve { name, png, data, width, height, rotation }.
 */
export async function prepareImage({ name = "imagem.png", type = "", data }) {
  const kind = type || (/\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : "");
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data], { type: kind }));
  } catch {
    throw new Error("A imagem copiada está num formato que não dá para abrir.");
  }
  const size = { width: bitmap.width, height: bitmap.height };
  const base = name.replace(/\.[^.]+$/, "") || "imagem";
  if (kind === "image/png" || kind === "image/jpeg") {
    bitmap.close();
    const png = kind === "image/png";
    return { name: `${base}.${png ? "png" : "jpg"}`, png, data, rotation: png ? 0 : jpegRotation(data), ...size };
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return { name: `${base}.png`, png: true, data: new Uint8Array(await blob.arrayBuffer()), rotation: 0, ...size };
}

/** Mensagem para quando não há imagem copiada. */
export function noImage() {
  toast("Não há imagem copiada. Copie uma imagem (no navegador, botão direito → Copiar imagem) ou um arquivo de imagem.", { duration: 6000 });
}
