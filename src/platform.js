// Camada de plataforma: no app desktop usa o Electron (diálogos nativos,
// salvar no mesmo arquivo, gravar em pastas); no navegador cai para
// <input type=file>, downloads e .zip.
const api = window.pdfApi;

export const isDesktop = Boolean(api);

export const FILTERS = {
  pdf: { name: "Documentos PDF", extensions: ["pdf"] },
  images: { name: "Imagens", extensions: ["png", "jpg", "jpeg"] },
  pdfAndImages: { name: "PDF e imagens", extensions: ["pdf", "png", "jpg", "jpeg"] },
  certificate: { name: "Certificado digital", extensions: ["pfx", "p12"] },
  text: { name: "Texto", extensions: ["txt"] },
  word: { name: "Documento do Word", extensions: ["docx"] },
};

const ACCEPT = {
  pdf: "application/pdf,.pdf",
  images: "image/png,image/jpeg,.png,.jpg,.jpeg",
  pdfAndImages: "application/pdf,.pdf,image/png,image/jpeg,.png,.jpg,.jpeg",
  certificate: ".pfx,.p12,application/x-pkcs12",
};

function pickWithInput(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", async () => resolve(await Promise.all([...input.files].map(fileFromBrowser))));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

export async function fileFromBrowser(file) {
  return {
    name: file.name,
    path: api?.getPathForFile(file) || null,
    data: new Uint8Array(await file.arrayBuffer()),
  };
}

/** Escolhe arquivos. `kind` é uma chave de FILTERS. Retorna [{ name, path, data }]. */
export async function pickFiles({ multiple = false, kind = "pdf" } = {}) {
  if (api) return api.openDialog({ multiple, filters: [FILTERS[kind]] });
  return pickWithInput(ACCEPT[kind], multiple);
}

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Salva um PDF. Retorna { name, path } ou null se o usuário cancelar. */
export async function saveFile(data, { path = null, suggestedName = "documento.pdf", saveAs = false, filter = "pdf" } = {}) {
  if (api) return api.saveFile({ data, filePath: path, suggestedName, saveAs, filter: FILTERS[filter] || null });
  download(data, suggestedName, filter === "pdf" ? "application/pdf" : "application/octet-stream");
  return { name: suggestedName, path: null };
}

/**
 * Salva vários arquivos de uma vez: no desktop numa pasta escolhida; no
 * navegador num .zip. Retorna uma descrição do destino ou null se cancelado.
 */
export async function saveFiles(files, { zipName = "arquivos.zip" } = {}) {
  if (api) {
    const dir = await api.pickDirectory({ title: "Escolha a pasta onde salvar os arquivos" });
    if (!dir) return null;
    const written = await api.writeFiles({ dir, files });
    return { where: dir, count: written.length };
  }
  if (files.length === 1) {
    download(files[0].data, files[0].name, "application/octet-stream");
    return { where: files[0].name, count: 1 };
  }
  const { zipSync } = await import("fflate");
  const entries = Object.fromEntries(files.map((f) => [f.name, [f.data, { level: 0 }]]));
  download(zipSync(entries), zipName, "application/zip");
  return { where: zipName, count: files.length };
}

export async function readPath(path) {
  return api ? api.readPath(path) : null;
}

export function setWindowState(state) {
  api?.setState(state);
}

export function closeWindow() {
  api?.closeWindow();
}

export function onMenu(callback) {
  api?.onMenu(callback);
}

export function onOpenFile(callback) {
  api?.onOpenFile(callback);
}

export async function getInitialFile() {
  return api ? api.getInitialFile() : null;
}

export function addRecentDocument(path) {
  api?.addRecent(path);
}

let userName = null;
/** Nome usado como autor dos comentários. */
export async function getUserName() {
  if (userName) return userName;
  try {
    userName = localStorage.getItem("authorName") || null;
  } catch {
    userName = null;
  }
  if (!userName && api) userName = await api.getUserName().catch(() => null);
  return (userName ||= "Usuário");
}

export function setUserName(name) {
  userName = name;
  try {
    localStorage.setItem("authorName", name);
  } catch {
    // Armazenamento indisponível: o nome vale só nesta sessão.
  }
}
