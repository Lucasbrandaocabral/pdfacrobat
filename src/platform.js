// Camada de plataforma: no app desktop usa o Electron (diálogos nativos,
// salvar no mesmo arquivo, gravar em pastas); no app Android, o plugin
// NativeFiles (seletor de arquivos do sistema, "Abrir com", impressão); no
// navegador cai para <input type=file>, downloads e .zip.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { toast } from "./ui.js";

const api = window.pdfApi;

export const isDesktop = Boolean(api);
export const isAndroid = !api && Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
const nativeFiles = isAndroid ? registerPlugin("NativeFiles") : null;

/** Versão deste build (a do package.json; no CI, a da tag publicada). */
export const APP_VERSION = __APP_VERSION__;

const MIME_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
};

function mimeOf(name) {
  return MIME_TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase()] || "application/octet-stream";
}

// Os bytes passam para o Android em base64.
function toBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
  // No Android o tipo do .pfx/.p12 varia entre aparelhos: mostra todos os arquivos.
  return pickWithInput(isAndroid && kind === "certificate" ? "" : ACCEPT[kind], multiple);
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
  if (nativeFiles) return saveOnAndroid(data, { uri: saveAs ? null : path, name: suggestedName });
  download(data, suggestedName, filter === "pdf" ? "application/pdf" : "application/octet-stream");
  return { name: suggestedName, path: null };
}

/**
 * No Android, `path` é o endereço (content://) do documento salvo antes:
 * "Salvar" grava nele de novo; sem ele, abre o "Salvar como" do sistema.
 */
async function saveOnAndroid(data, { uri, name }) {
  const payload = { name, mimeType: mimeOf(name), data: toBase64(data) };
  if (uri) {
    try {
      const saved = await nativeFiles.save({ ...payload, uri });
      return { name: saved.name, path: saved.uri };
    } catch {
      // Sem permissão para gravar de novo no mesmo lugar: pergunta onde salvar.
    }
  }
  const saved = await nativeFiles.save(payload);
  return saved.canceled ? null : { name: saved.name, path: saved.uri };
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
  if (nativeFiles) {
    const result = await nativeFiles.saveMany({ files: files.map((f) => ({ name: f.name, mimeType: mimeOf(f.name), data: toBase64(f.data) })) });
    return result.canceled ? null : { where: result.folder, count: result.count };
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
  // Android: PDFs abertos com "Abrir com" ou recebidos por "Compartilhar",
  // inclusive o que abriu o app.
  nativeFiles?.addListener("fileOpened", ({ files = [], error }) => {
    if (error) toast(`Não foi possível abrir o arquivo recebido: ${error}`, { duration: 6000 });
    for (const file of files) {
      const name = /\.[a-z0-9]+$/i.test(file.name) || file.mimeType !== "application/pdf" ? file.name : `${file.name}.pdf`;
      callback({ name, path: null, data: fromBase64(file.data) });
    }
  });
}

/**
 * Imprime pelo serviço de impressão do Android, que já abre com o papel
 * (`paper`, chave de PAPERS) e a orientação sugeridos.
 */
export async function printPdf(data, name, { paper = null, landscape = false } = {}) {
  await nativeFiles.print({ name, data: toBase64(data), paper, landscape });
}

/** Impressoras do sistema, no app desktop: [{ name, displayName, isDefault }]. */
export async function listPrinters() {
  if (!api?.listPrinters) return [];
  return api.listPrinters().catch(() => []);
}

/**
 * App desktop: manda o PDF direto para a impressora, sem a janela de
 * impressão do sistema. Retorna { ok, reason }.
 */
export function printDirect(options) {
  return api.printPdf(options);
}

export async function getInitialFile() {
  return api ? api.getInitialFile() : null;
}

export function addRecentDocument(path) {
  api?.addRecent(path);
}

/** Atualização do app desktop (no navegador a versão web se atualiza sozinha). */
export const updates = isAndroid
  ? androidUpdates()
  : {
      getStatus: () => api?.getUpdateStatus() ?? Promise.resolve(null),
      onStatus: (callback) => api?.onUpdateStatus(callback),
      check: () => api?.checkForUpdates(),
      download: () => api?.downloadUpdate(),
      install: () => api?.installUpdate(),
    };

const LATEST_RELEASE = "https://api.github.com/repos/Lucasbrandaocabral/pdfacrobat/releases/latest";

function isNewer(version, than) {
  const parts = (v) => v.split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * App Android: procura nas Releases do GitHub uma versão com APK mais nova e,
 * ao baixar, abre o download no navegador (tocar no arquivo instala).
 */
function androidUpdates() {
  const listeners = new Set();
  let status = null;
  let apkUrl = null;
  const emit = (next) => {
    status = next;
    listeners.forEach((callback) => callback(next));
  };
  async function check(manual) {
    if (manual) emit({ state: "checking", manual });
    try {
      const response = await fetch(LATEST_RELEASE, { headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = await response.json();
      const version = String(release.tag_name || "").replace(/^v/i, "");
      const apk = (release.assets || []).find((asset) => /-android\.apk$/i.test(asset.name));
      if (apk && isNewer(version, APP_VERSION)) {
        apkUrl = apk.browser_download_url;
        emit({ state: "available", version, manual });
      } else {
        emit({ state: "latest", version: APP_VERSION, manual });
      }
    } catch {
      emit({ state: "error", manual, message: "Não foi possível procurar atualizações. Verifique a conexão com a internet." });
    }
  }
  return {
    getStatus: async () => status,
    onStatus: (callback) => listeners.add(callback),
    check: () => check(true),
    // Ao abrir o app, sem atrapalhar o carregamento.
    autoCheck: () => setTimeout(() => check(false), 5000),
    download: async () => {
      if (!apkUrl) return;
      await nativeFiles.openUrl({ url: apkUrl });
      emit({ ...status, state: "opened" });
    },
    install: () => {},
  };
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

/** Nome que o próprio usuário informou (sem cair no nome da conta do sistema). */
export function savedUserName() {
  try {
    return localStorage.getItem("authorName") || null;
  } catch {
    return null;
  }
}

export function setUserName(name) {
  userName = name;
  try {
    localStorage.setItem("authorName", name);
  } catch {
    // Armazenamento indisponível: o nome vale só nesta sessão.
  }
}
