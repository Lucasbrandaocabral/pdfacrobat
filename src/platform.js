// Camada de plataforma: no app desktop usa o Electron (diálogos nativos,
// salvar no mesmo arquivo); no navegador cai para <input type=file> e download.
const api = window.pdfApi;

export const isDesktop = Boolean(api);

function pickWithInput(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", async () => {
      resolve(await Promise.all([...input.files].map(fileFromBrowser)));
    });
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

/** Abre um ou mais arquivos. Retorna [{ name, path, data }]. */
export async function pickFiles({ multiple = false, images = false, pdfOnly = false } = {}) {
  if (api) return api.openDialog({ multiple, images });
  const accept = images ? "image/png,image/jpeg" : pdfOnly ? "application/pdf,.pdf" : "application/pdf,.pdf,image/png,image/jpeg";
  return pickWithInput(accept, multiple);
}

/** Salva bytes. Retorna { name, path } ou null se o usuário cancelar. */
export async function saveFile(data, { path = null, suggestedName = "documento.pdf", saveAs = false } = {}) {
  if (api) return api.saveFile({ data, filePath: path, suggestedName, saveAs });

  const blob = new Blob([data], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name: suggestedName, path: null };
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
